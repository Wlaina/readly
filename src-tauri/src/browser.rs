//! 书源用的“隐藏浏览器”（电脑端）。
//!
//! 轻小说文库、哔哩轻小说前面有 Cloudflare：直接用 HTTP 库请求会被拦（403），
//! 有的页面还要靠网页自己的脚本把正文解出来。所以用隐藏的 WebView2 窗口真正打开网页，
//! 等页面就绪后用 eval_with_callback 把整页 HTML 取回来，解析交给前端。
//!
//! 最多 SLOTS 个隐藏窗口（下载时并行抓几章）；它们共用同一份 Cookie，登录 / 验证一次就都生效。
//! 这些窗口没有任何 capability：网页本身调用不了 Readly 的任何命令，只能被动地被读取。
//! 需要人机验证或登录时，把窗口显示出来，由用户自己在官方页面里操作。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const SLOTS: usize = 3;

/// 每个隐藏窗口同一时间只给一个请求用（网页是一页一页加载的）
pub struct BrowserLock(pub [tauri::async_runtime::Mutex<()>; SLOTS]);

impl Default for BrowserLock {
    fn default() -> Self {
        Self(std::array::from_fn(|_| tauri::async_runtime::Mutex::new(())))
    }
}

/// “全部取消”的代数：browser_cancel 加一，正在等的加载看到变化就立刻结束
static CANCEL_GEN: AtomicU64 = AtomicU64::new(0);

fn label(slot: usize) -> String {
    if slot == 0 { "browser".into() } else { format!("browser-{slot}") }
}

fn parse_url(url: &str) -> Result<Url, String> {
    let u = Url::parse(url).map_err(|e| e.to_string())?;
    if u.scheme() != "https" && u.scheme() != "http" {
        return Err("只允许网页地址".into());
    }
    Ok(u)
}

fn window(app: &AppHandle, slot: usize, url: &Url) -> Result<(WebviewWindow, bool), String> {
    let name = label(slot);
    if let Some(w) = app.get_webview_window(&name) {
        return Ok((w, false));
    }
    let w = WebviewWindowBuilder::new(app, &name, WebviewUrl::External(url.clone()))
        .title("Readly · 书源网页")
        .inner_size(960.0, 760.0)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    // 用户关掉窗口时只隐藏，保留会话
    let w2 = w.clone();
    w.on_window_event(move |e| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = e {
            api.prevent_close();
            let _ = w2.hide();
            let _ = w2.app_handle().emit("browser-hidden", ());
        }
    });
    Ok((w, true))
}

/// 在网页里执行一段脚本，返回它最后一个表达式的值（字符串）
async fn eval(w: &WebviewWindow, js: &str) -> Result<String, String> {
    let (tx, rx) = tokio::sync::mpsc::channel::<String>(1);
    w.eval_with_callback(js, move |json| {
        let _ = tx.try_send(json);
    })
    .map_err(|e| e.to_string())?;
    let mut rx = rx;
    let json = tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .map_err(|_| "脚本执行超时".to_string())?
        .ok_or("脚本没有返回")?;
    // 回调给的是 JSON；字符串结果需要再解一层
    Ok(serde_json::from_str::<String>(&json).unwrap_or(json))
}

/// 页面状态探测脚本：返回 OLD / LOADING / CHALLENGE / WAIT / OK:{"url","html","data"}
/// （安卓端的同一份在 src/lib/sources/browser.ts，两边要一起改）
/// 内容稳定：目标元素连续两次一样才读；但最多等 1.5 秒（页面上有轮播广告时内容会一直变）
fn probe(selector: &str, extract: &str, no_html: bool, wait_all: bool) -> String {
    // 默认网页结构出来（interactive）就读，不等广告、图片全部加载完；验证码这类要看图的页面才等 complete
    let ready = if wait_all { "document.readyState !== 'complete'" } else { "document.readyState === 'loading'" };
    let sel = serde_json::to_string(selector).unwrap();
    let html = if no_html { "''" } else { "document.documentElement.outerHTML" };
    let extract = if extract.is_empty() { "null" } else { extract };
    format!(
        r#"(function(){{try{{
  if (window.__readlyOld) return 'OLD';
  if ({ready}) return 'LOADING';
  var t = document.title || '';
  if (document.querySelector('#challenge-form,#cf-challenge-running,.cf-turnstile,[id^="cf-chl-"],#challenge-stage') || /Just a moment|请稍候|Attention Required/i.test(t)) return 'CHALLENGE';
  // 网站限流 / 拒绝访问：立刻报错（由下载那边稍等再重试），不要傻等到超时
  if (/Access denied|Too Many Requests|Error 10[0-9][0-9]|访问过于频繁|请求过于频繁/i.test(t)) return 'BLOCKED:' + t.slice(0, 60);
  var sel = {sel};
  var box = sel ? document.querySelector(sel) : document.body;
  if (!box) {{ window.__readlyFound = 0; return 'WAIT:' + location.host + ' ' + t.slice(0, 40); }}
  var now = Date.now();
  if (!window.__readlyFound) window.__readlyFound = now;
  var sig = box.innerHTML.length;
  if (window.__readlySig !== sig && now - window.__readlyFound < 1500) {{ window.__readlySig = sig; return 'WAIT'; }}
  var data = null;
  try {{ data = ({extract}); }} catch (e) {{ data = {{ error: String(e) }}; }}
  return 'OK:' + JSON.stringify({{ url: location.href, html: {html}, data: data }});
}}catch(e){{return 'ERR:' + e}}}})()"#
    )
}

/// 用隐藏窗口打开网页，等到页面就绪（且 selector 出现）后返回最终地址和整页 HTML。
/// 遇到人机验证会把窗口显示出来并通知前端，等用户完成后继续。
#[tauri::command]
pub async fn browser_load(
    app: AppHandle,
    lock: tauri::State<'_, BrowserLock>,
    url: String,
    selector: Option<String>,
    extract: Option<String>,
    timeout_ms: Option<u64>,
    action: Option<String>,
    slot: Option<usize>,
    no_html: Option<bool>,
    wait_all: Option<bool>,
) -> Result<serde_json::Value, String> {
    let slot = slot.unwrap_or(0).min(SLOTS - 1);
    let gen = CANCEL_GEN.load(Ordering::SeqCst);
    let _guard = lock.0[slot].lock().await;
    if CANCEL_GEN.load(Ordering::SeqCst) != gen {
        return Err("已取消".into());
    }
    load(&app, slot, gen, &url, selector, extract, timeout_ms, action, no_html.unwrap_or(false), wait_all.unwrap_or(false)).await
}

/// 取消所有正在进行和排队的加载
#[tauri::command]
pub fn browser_cancel() {
    CANCEL_GEN.fetch_add(1, Ordering::SeqCst);
}

#[allow(clippy::too_many_arguments)]
async fn load(
    app: &AppHandle,
    slot: usize,
    gen: u64,
    url: &str,
    selector: Option<String>,
    extract: Option<String>,
    timeout_ms: Option<u64>,
    action: Option<String>,
    no_html: bool,
    wait_all: bool,
) -> Result<serde_json::Value, String> {
    let app = app.clone();
    let target = parse_url(url)?;
    let (w, created) = window(&app, slot, &target)?;
    // 新页面不带这些记号，用来区分“还是旧页面”
    const RESET: &str = "window.__readlyOld = 1; window.__readlySig = undefined; window.__readlyFound = 0;";
    if let Some(action) = action.filter(|a| !a.is_empty()) {
        // 不换网址，而是在当前页面里执行一段操作（例如填好验证码后提交表单），再等新页面
        if created {
            return Err("没有可以操作的页面".into());
        }
        eval(&w, &format!("{RESET} (function(){{ {action} }})(); 1")).await?;
    } else if !created {
        let _ = eval(&w, &format!("{RESET} 1")).await;
        w.navigate(target.clone()).map_err(|e| e.to_string())?;
    }
    let selector = selector.unwrap_or_default();
    let js = probe(&selector, &extract.unwrap_or_default(), no_html, wait_all);
    let limit = Duration::from_millis(timeout_ms.unwrap_or(30_000));
    let start = Instant::now();
    let mut challenged_at: Option<Instant> = None;
    loop {
        tokio::time::sleep(Duration::from_millis(200)).await;
        if CANCEL_GEN.load(Ordering::SeqCst) != gen {
            if challenged_at.is_some() {
                let _ = w.hide();
            }
            return Err("已取消".into());
        }
        let r = eval(&w, &js).await.unwrap_or_else(|e| format!("ERR:{e}"));
        if let Some(t) = r.strip_prefix("BLOCKED:") {
            return Err(format!("网站暂时拒绝访问（{t}），稍后重试"));
        }
        if let Some(rest) = r.strip_prefix("OK:") {
            if challenged_at.is_some() {
                let _ = w.hide();
                let _ = app.emit("browser-challenge", false);
            }
            return serde_json::from_str(rest).map_err(|e| e.to_string());
        }
        if r == "CHALLENGE" {
            // 自动验证一般几秒内就过；超过 4 秒还在，就请用户手动完成（不计入超时）
            let since = *challenged_at.get_or_insert_with(Instant::now);
            if since.elapsed() > Duration::from_secs(4) && !w.is_visible().unwrap_or(false) {
                let _ = w.show();
                let _ = w.set_focus();
                let _ = app.emit("browser-challenge", true);
            }
            if since.elapsed() > Duration::from_secs(300) {
                return Err("人机验证未完成".into());
            }
            continue;
        }
        if challenged_at.is_none() && start.elapsed() > limit {
            return Err(format!("网页加载超时（{r}）"));
        }
    }
}

/// 显示书源网页窗口（登录、手动验证用）。
/// auto_close：打开的是登录页时，登录成功、网页跳离登录页后自动收起窗口
#[tauri::command]
pub async fn browser_show(app: AppHandle, url: String, auto_close: Option<bool>) -> Result<(), String> {
    let target = parse_url(&url)?;
    let (w, created) = window(&app, 0, &target)?;
    if !created {
        w.navigate(target).map_err(|e| e.to_string())?;
    }
    w.show().map_err(|e| e.to_string())?;
    w.set_focus().map_err(|e| e.to_string())?;
    if auto_close.unwrap_or(false) {
        tauri::async_runtime::spawn(async move {
            // 先等登录页真正打开，再看它什么时候跳走
            let mut seen_login = false;
            for _ in 0..900 {
                tokio::time::sleep(Duration::from_millis(700)).await;
                if !w.is_visible().unwrap_or(false) {
                    return;
                }
                let Ok(cur) = w.url() else { continue };
                let on_login = cur.path().contains("login");
                if on_login {
                    seen_login = true;
                } else if seen_login {
                    tokio::time::sleep(Duration::from_millis(1200)).await;
                    let _ = w.hide();
                    let _ = w.app_handle().emit("browser-hidden", ());
                    return;
                }
            }
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_hide(app: AppHandle) -> Result<(), String> {
    for slot in 0..SLOTS {
        if let Some(w) = app.get_webview_window(&label(slot)) {
            w.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 开发调试：设置环境变量 READLY_BROWSER_TEST=<输出目录> 启动时，依次打开几个测试网页，把结果写进该目录
#[cfg(debug_assertions)]
pub fn self_test(app: &AppHandle) {
    let Ok(dir) = std::env::var("READLY_BROWSER_TEST") else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        let cases = [
            ("bilinovel-search", "https://www.bilinovel.com/search.html?searchkey=%E9%AD%94%E5%A5%B3%E4%B9%8B%E6%97%85", "body"),
            ("wenku8-search", "https://www.wenku8.net/modules/article/search.php?searchtype=articlename&searchkey=%C4%A7%C5%AE", "body"),
        ];
        for (name, url, sel) in cases {
            let t = Instant::now();
            let gen = CANCEL_GEN.load(Ordering::SeqCst);
            let r = load(&app, 0, gen, url, Some(sel.into()), None, Some(40_000), None, false, true).await;
            let (status, body) = match r {
                Ok(v) => (format!("OK {}", v["url"].as_str().unwrap_or("")), v["html"].as_str().unwrap_or("").to_string()),
                Err(e) => (format!("ERR {e}"), String::new()),
            };
            let line = format!("{name}\t{:.1}s\t{status}\t{} bytes\n", t.elapsed().as_secs_f32(), body.len());
            let _ = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(format!("{dir}/result.txt"))
                .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
            let _ = std::fs::write(format!("{dir}/{name}.html"), body);
        }
        let _ = std::fs::write(format!("{dir}/done.txt"), "done");
    });
}
