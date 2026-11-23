use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[allow(unused_imports)]
use tauri::{Emitter, Manager};

#[cfg(desktop)]
mod browser;
#[cfg(desktop)]
use browser::{browser_cancel, browser_hide, browser_load, browser_show};

/* 书源隐藏浏览器：安卓走 MainActivity 里的原生 WebView，这几个命令只在电脑端有实现 */
#[cfg(mobile)]
#[tauri::command]
async fn browser_load() -> Result<(), String> {
    Err("unsupported".into())
}
#[cfg(mobile)]
#[tauri::command]
async fn browser_show() -> Result<(), String> {
    Err("unsupported".into())
}
#[cfg(mobile)]
#[tauri::command]
async fn browser_hide() -> Result<(), String> {
    Err("unsupported".into())
}
#[cfg(mobile)]
#[tauri::command]
fn browser_cancel() {}

/// 通过“打开方式”传进来的书籍文件
#[derive(Default)]
struct OpenFiles {
    /// 前端尚未取走的文件
    pending: Mutex<Vec<String>>,
    /// 允许前端读取的路径（只放行系统传进来的文件）
    allowed: Mutex<HashSet<String>>,
}

impl OpenFiles {
    fn add(&self, files: &[String]) {
        let mut allowed = self.allowed.lock().unwrap();
        for f in files {
            allowed.insert(f.clone());
        }
    }
}

fn is_book(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("epub") | Some("txt")
    )
}

/// 从命令行参数里挑出书籍文件（跳过第 0 个参数，即程序自身）
fn book_args(args: &[String], cwd: Option<&str>) -> Vec<String> {
    args.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(a);
            match (p.is_absolute(), cwd) {
                (false, Some(dir)) => Path::new(dir).join(p),
                _ => p,
            }
        })
        .filter(|p| is_book(p) && p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[tauri::command]
#[allow(unused_variables)]
fn take_open_files(app: tauri::AppHandle, state: tauri::State<OpenFiles>) -> Vec<String> {
    #[allow(unused_mut)]
    let mut files = std::mem::take(&mut *state.pending.lock().unwrap());
    // 安卓：MainActivity 把 content:// 文件复制到 cache/open-files，并把路径写进 pending.txt
    #[cfg(target_os = "android")]
    if let Ok(cache) = app.path().app_cache_dir() {
        let list = cache.join("open-files").join("pending.txt");
        if let Ok(text) = std::fs::read_to_string(&list) {
            let _ = std::fs::remove_file(&list);
            let found: Vec<String> = text
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty() && Path::new(l).is_file())
                .collect();
            state.add(&found);
            files.extend(found);
        }
    }
    files
}

#[tauri::command]
fn read_open_file(path: String, state: tauri::State<OpenFiles>) -> Result<tauri::ipc::Response, String> {
    if !state.allowed.lock().unwrap().contains(&path) {
        return Err("不允许读取该文件".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    // 以二进制直接返回，避免大文件走 JSON 序列化
    Ok(tauri::ipc::Response::new(bytes))
}

/// 便携版没有安装器：把当前 exe 注册到 .epub / .txt 的“打开方式”（仅当前用户，不抢默认程序）
#[tauri::command]
fn set_open_with(enable: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe_path = exe.to_string_lossy().into_owned();
        let exe_name = exe.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let classes = r"HKCU\Software\Classes";
        let progid = format!(r"{classes}\Readly.Book");
        let app = format!(r"{classes}\Applications\{exe_name}");
        let open_cmd = format!("\"{exe_path}\" \"%1\"");
        let icon = format!("\"{exe_path}\",0");

        let reg = |args: &[&str]| -> Result<(), String> {
            let out = std::process::Command::new("reg")
                .args(args)
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map_err(|e| e.to_string())?;
            if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).into_owned()) }
        };

        if enable {
            reg(&["add", &progid, "/ve", "/d", "电子书", "/f"])?;
            reg(&["add", &format!(r"{progid}\DefaultIcon"), "/ve", "/d", &icon, "/f"])?;
            reg(&["add", &format!(r"{progid}\shell\open\command"), "/ve", "/d", &open_cmd, "/f"])?;
            for ext in [".epub", ".txt"] {
                reg(&["add", &format!(r"{classes}\{ext}\OpenWithProgids"), "/v", "Readly.Book", "/d", "", "/f"])?;
                reg(&["add", &format!(r"{app}\SupportedTypes"), "/v", ext, "/d", "", "/f"])?;
            }
            reg(&["add", &format!(r"{app}\shell\open\command"), "/ve", "/d", &open_cmd, "/f"])?;
        } else {
            let _ = reg(&["delete", &progid, "/f"]);
            let _ = reg(&["delete", &app, "/f"]);
            for ext in [".epub", ".txt"] {
                let _ = reg(&["delete", &format!(r"{classes}\{ext}\OpenWithProgids"), "/v", "Readly.Book", "/f"]);
            }
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = enable;
        Err("仅 Windows 支持".into())
    }
}

/* ---------- 书籍文件夹：扫描与读取 ---------- */

#[derive(serde::Serialize)]
struct FolderEntry {
    rel: String,
    size: u64,
    mtime: u64,
}

fn walk_books(dir: &Path, root: &Path, depth: u32, out: &mut Vec<FolderEntry>) {
    if depth > 6 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let Ok(md) = e.metadata() else { continue };
        if md.is_dir() {
            // 跳过隐藏目录与回收站
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.starts_with('.') && !name.starts_with('$') {
                walk_books(&p, root, depth + 1, out);
            }
        } else if is_book(&p) {
            let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().replace('\\', "/");
            let mtime = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(FolderEntry { rel, size: md.len(), mtime });
        }
    }
}

/// 递归列出文件夹里的 epub / txt
#[tauri::command]
fn scan_folder(path: String) -> Result<Vec<FolderEntry>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("找不到文件夹：{path}"));
    }
    let mut out = Vec::new();
    walk_books(&root, &root, 0, &mut out);
    Ok(out)
}

/// 读取书籍文件夹中的一本书（只允许读文件夹内部的 epub / txt）
#[tauri::command]
fn read_folder_file(root: String, rel: String) -> Result<tauri::ipc::Response, String> {
    let root = PathBuf::from(root).canonicalize().map_err(|e| e.to_string())?;
    let p = root.join(&rel).canonicalize().map_err(|e| e.to_string())?;
    if !p.starts_with(&root) || !is_book(&p) {
        return Err("不允许读取该文件".into());
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 把修改后的书写回书籍文件夹里的原文件（编辑书籍信息后双向同步用）。
/// 请求体是文件内容；路径在请求头 x-root / x-rel 中（URL 编码）。
/// 只允许覆盖文件夹内已存在的 epub / txt；先写临时文件再替换，不会留下写了一半的文件。
#[tauri::command]
fn write_folder_file(request: tauri::ipc::Request<'_>) -> Result<FolderEntry, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("需要二进制内容".into());
    };
    let header = |k: &str| -> Result<String, String> {
        let v = request.headers().get(k).and_then(|v| v.to_str().ok()).ok_or(format!("缺少 {k}"))?;
        percent_encoding::percent_decode_str(v)
            .decode_utf8()
            .map(|s| s.into_owned())
            .map_err(|e| e.to_string())
    };
    let root = PathBuf::from(header("x-root")?).canonicalize().map_err(|e| e.to_string())?;
    let rel = header("x-rel")?;
    let target = root.join(&rel).canonicalize().map_err(|e| format!("找不到原文件：{e}"))?;
    if !target.starts_with(&root) || !is_book(&target) || !target.is_file() {
        return Err("不允许写入该文件".into());
    }
    let tmp = target.with_extension("readly-tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    let md = std::fs::metadata(&target).map_err(|e| e.to_string())?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FolderEntry { rel: rel.replace('\\', "/"), size: md.len(), mtime })
}

/// 把书新建到书籍文件夹里（电脑端：其他设备添加的书存进 OneDrive 等文件夹）。
/// 请求体是文件内容；x-root 为文件夹，x-rel 为希望的文件名（URL 编码）。
/// 从不覆盖已有文件：重名时改成“书名 (2).epub”；先写临时文件再改名。
#[tauri::command]
fn create_folder_file(request: tauri::ipc::Request<'_>) -> Result<FolderEntry, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("需要二进制内容".into());
    };
    let header = |k: &str| -> Result<String, String> {
        let v = request.headers().get(k).and_then(|v| v.to_str().ok()).ok_or(format!("缺少 {k}"))?;
        percent_encoding::percent_decode_str(v)
            .decode_utf8()
            .map(|s| s.into_owned())
            .map_err(|e| e.to_string())
    };
    let root = PathBuf::from(header("x-root")?).canonicalize().map_err(|e| format!("找不到文件夹：{e}"))?;
    let rel = header("x-rel")?;
    // 只允许文件夹根目录下的普通文件名
    if rel.is_empty() || rel.contains(['/', '\\', ':']) || rel.starts_with('.') {
        return Err("文件名不合法".into());
    }
    let first = root.join(&rel);
    if !is_book(&first) {
        return Err("只能写入 epub / txt".into());
    }
    let stem = first.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = first.extension().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut target = first.clone();
    let mut n = 2;
    while target.exists() {
        if n > 99 {
            return Err("重名文件太多".into());
        }
        target = root.join(format!("{stem} ({n}).{ext}"));
        n += 1;
    }
    let tmp = target.with_extension("readly-tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    let md = std::fs::metadata(&target).map_err(|e| e.to_string())?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let rel = target.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or(rel);
    Ok(FolderEntry { rel, size: md.len(), mtime })
}

/// 删除书籍文件夹里的一本书（书架上移除书时可选“同时删除文件夹里的文件”）。
/// 只允许删除文件夹内部已存在的 epub / txt 普通文件；文件已经不在了视为成功。
/// 直接删除，不进回收站（OneDrive 等同步盘在网页端回收站里仍可找回）。
#[tauri::command]
fn delete_folder_file(root: String, rel: String) -> Result<(), String> {
    let root = PathBuf::from(root).canonicalize().map_err(|e| format!("找不到文件夹：{e}"))?;
    if rel.is_empty() {
        return Err("文件名不合法".into());
    }
    let joined = root.join(&rel);
    if !joined.exists() {
        return Ok(());
    }
    let target = joined.canonicalize().map_err(|e| e.to_string())?;
    if !target.starts_with(&root) || target == root || !is_book(&target) || !target.is_file() {
        return Err("不允许删除该文件".into());
    }
    std::fs::remove_file(&target).map_err(|e| e.to_string())
}

/// 书源：下载插图 / 封面。图片站有防盗链，要带上来源页（浏览器端的 fetch 不能设置 Referer）。
/// 只接受图片，最大 20 MB。
#[tauri::command]
async fn fetch_image(url: String, referer: String) -> Result<tauri::ipc::Response, String> {
    use tauri_plugin_http::reqwest;
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("只允许网页地址".into());
    }
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(40))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).header("Referer", referer).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("图片太大".into());
    }
    let head = &bytes[..bytes.len().min(12)];
    let is_image = head.starts_with(&[0xff, 0xd8])
        || head.starts_with(&[0x89, b'P', b'N', b'G'])
        || head.starts_with(b"GIF8")
        || (head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP");
    if !is_image {
        return Err("不是图片".into());
    }
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

/// 安卓：读取 MainActivity 复制到缓存目录的书籍文件，读完即删
#[tauri::command]
fn read_cache_file(path: String) -> Result<tauri::ipc::Response, String> {
    let p = PathBuf::from(&path).canonicalize().map_err(|e| e.to_string())?;
    let s = p.to_string_lossy();
    if !(s.contains("/cache/readly-folder/") && is_book(&p)) {
        return Err("不允许读取该文件".into());
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&p);
    Ok(tauri::ipc::Response::new(bytes))
}

/// 用系统默认浏览器打开网址（只允许 http/https，防止被用来执行其他程序）
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("只支持网页地址".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // rundll32 直接调用系统的“打开网址”，不经过命令行解析，地址里的 & 等符号不会出问题
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = url;
        Err("当前平台由前端处理".into())
    }
}

/// 把诊断日志等文本写到用户在“另存为”对话框里选的位置
#[tauri::command]
fn write_text_file(path: String, text: String) -> Result<(), String> {
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn from_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

/// 用 Windows DPAPI 加密敏感信息（WebDAV 密码）：只有当前 Windows 用户在这台电脑上能解开，
/// 不需要额外输入任何密码。返回十六进制密文；其他平台返回空串（前端会退回到原有方式）。
#[tauri::command]
fn protect_secret(text: String) -> String {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
        let input = CRYPT_INTEGER_BLOB { cbData: text.len() as u32, pbData: text.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ok = CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0x1 /* UI_FORBIDDEN */, &mut out);
        if ok == 0 || out.pbData.is_null() {
            return String::new();
        }
        let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as _);
        return to_hex(&bytes);
    }
    #[cfg(not(windows))]
    {
        let _ = text;
        String::new()
    }
}

/// 解密 protect_secret 的结果；失败（例如换了 Windows 账户）返回 Err，前端会让你重新输入密码
#[tauri::command]
fn unprotect_secret(hex: String) -> Result<String, String> {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
        let data = from_hex(&hex).ok_or("密文格式不正确")?;
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ok = CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0x1, &mut out);
        if ok == 0 || out.pbData.is_null() {
            return Err("无法解密".into());
        }
        let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as _);
        return String::from_utf8(bytes).map_err(|e| e.to_string());
    }
    #[cfg(not(windows))]
    {
        let _ = (hex, from_hex as fn(&str) -> Option<Vec<u8>>, to_hex as fn(&[u8]) -> String);
        Err("当前平台不支持".into())
    }
}

/// 在资源管理器中显示文件（选中它）；文件不存在时打开所在文件夹
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let p = PathBuf::from(path.replace('/', "\\"));
        let mut cmd = std::process::Command::new("explorer.exe");
        if p.exists() {
            // /select, 后面必须紧跟路径，作为一个整体参数传入
            cmd.raw_arg(format!("/select,\"{}\"", p.display()));
        } else if let Some(dir) = p.parent().filter(|d| d.exists()) {
            cmd.arg(dir);
        } else {
            return Err("文件不存在".into());
        }
        cmd.spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("当前平台不支持".into())
    }
}

/// Windows 个性化里的强调色（注册表 DWM\AccentColor，格式 0xAABBGGRR）
#[tauri::command]
fn get_accent_color() -> String {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let out = std::process::Command::new("reg")
            .args(["query", r"HKCU\Software\Microsoft\Windows\DWM", "/v", "AccentColor"])
            .creation_flags(0x0800_0000)
            .output();
        if let Ok(out) = out {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(hex) = text.split_whitespace().find(|s| s.starts_with("0x")) {
                if let Ok(v) = u32::from_str_radix(&hex[2..], 16) {
                    let (r, g, b) = (v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff);
                    return format!("#{r:02x}{g:02x}{b:02x}");
                }
            }
        }
    }
    String::new()
}

#[cfg(desktop)]
type BrowserLockState = browser::BrowserLock;
#[cfg(mobile)]
type BrowserLockState = ();

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial = book_args(&std::env::args().collect::<Vec<_>>(), None);
    let open_files = OpenFiles::default();
    open_files.add(&initial);
    *open_files.pending.lock().unwrap() = initial;

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // 桌面端：已有窗口时，把新打开的文件转交给现有实例
    #[cfg(desktop)]
    {
        // 自动更新（GitHub Releases）
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let files = book_args(&args, Some(&cwd));
            if !files.is_empty() {
                app.state::<OpenFiles>().add(&files);
                let _ = app.emit("open-files", files);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }

    builder
        .setup(|_app| {
            // 窗口启动时隐藏，等前端套好深浅色再显示；3 秒后仍未显示则强制显示（兜底，防止前端出错导致窗口一直看不见）
            #[cfg(desktop)]
            {
                let handle = _app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    if let Some(w) = handle.get_webview_window("main") {
                        if !w.is_visible().unwrap_or(true) {
                            let _ = w.show();
                        }
                    }
                });
            }
            #[cfg(all(desktop, debug_assertions))]
            browser::self_test(_app.handle());
            Ok(())
        })
        .manage(open_files)
        .manage(BrowserLockState::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![take_open_files,
            read_open_file,
            set_open_with,
            get_accent_color,
            reveal_path,
            protect_secret,
            unprotect_secret,
            write_text_file,
            open_url,
            scan_folder,
            read_folder_file,
            write_folder_file,
            create_folder_file,
            delete_folder_file,
            read_cache_file,
            browser_load,
            browser_show,
            browser_hide,
            browser_cancel,
            fetch_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running Readly");
}
