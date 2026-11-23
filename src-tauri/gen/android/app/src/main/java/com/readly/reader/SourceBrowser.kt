package com.readly.reader

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import org.json.JSONObject

/**
 * 书源用的“隐藏浏览器”（安卓端，对应电脑端的 Rust browser.rs）。
 *
 * 轻小说文库、哔哩轻小说前面有 Cloudflare，直接请求会被拦或只给残缺内容；
 * 所以用系统 WebView 真正打开网页，页面就绪后取回 HTML，解析交给前端。
 * 最多 SLOTS 个 WebView（下载时并行抓几章），每个有自己的队列；它们共用同一份 Cookie。
 * 这些 WebView 不注入任何桥接对象：网页本身调用不了 Readly 的任何功能。
 * 平时放在主界面后面（不可见但会正常排版）；需要登录或人机验证时盖到最上面，按返回键收起。
 *
 * 前端传来的 script 是“状态探测脚本”，返回 LOADING / CHALLENGE / WAIT / OK:{json} 等，由前端统一维护。
 */
class SourceBrowser(private val activity: Activity, private val notify: (String) -> Unit) {
  companion object {
    const val SLOTS = 3
  }

  private val main = Handler(Looper.getMainLooper())
  private val results = HashMap<String, String>()
  private val workers = List(SLOTS) { Worker() }
  private var defaultUa: String? = null
  /** “全部取消”的代数：变了就丢掉正在等和排队的请求 */
  private var gen = 0

  private class Job(
    val id: String, val url: String, val script: String, val timeoutMs: Long,
    val desktop: Boolean, val action: String, val images: Boolean, val gen: Int,
  ) {
    val start = System.currentTimeMillis()
    var challengedAt = 0L
  }

  private inner class Worker {
    var web: WebView? = null
    var frame: FrameLayout? = null
    var current: Job? = null
    val queue = ArrayDeque<Job>()
    val visible: Boolean get() = frame?.parent != null

    @SuppressLint("SetJavaScriptEnabled")
    fun ensure(): WebView {
      web?.let { return it }
      val w = WebView(activity)
      w.settings.javaScriptEnabled = true
      w.settings.domStorageEnabled = true
      w.settings.loadsImagesAutomatically = false
      w.webViewClient = BlockingClient()
      CookieManager.getInstance().setAcceptCookie(true)
      CookieManager.getInstance().setAcceptThirdPartyCookies(w, true)
      val f = FrameLayout(activity)
      f.setBackgroundColor(Color.WHITE)
      f.addView(w, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
      val tip = TextView(activity).apply {
        text = "完成登录或验证后，按返回键回到 Readly"
        setTextColor(Color.WHITE)
        setBackgroundColor(0xCC30302E.toInt())
        setPadding(32, 20, 32, 20)
        gravity = Gravity.CENTER
      }
      f.addView(tip, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
      web = w
      frame = f
      // 平时不挂到界面上（像 LNR 那样的“独立网页”）：挂在界面里时，Readly 一退到后台它就跟着被挂起，
      // 后台下载就停了。不挂上去就要自己给它一个大小，网页才能正常排版（读取段落位置要用）
      layoutDetached()
      return w
    }

    /** 不在界面上时，手动量一下大小（和屏幕一样大），网页按这个尺寸排版 */
    fun layoutDetached() {
      val f = frame ?: return
      val dm = activity.resources.displayMetrics
      val wSpec = View.MeasureSpec.makeMeasureSpec(dm.widthPixels, View.MeasureSpec.EXACTLY)
      val hSpec = View.MeasureSpec.makeMeasureSpec(dm.heightPixels, View.MeasureSpec.EXACTLY)
      f.measure(wSpec, hSpec)
      f.layout(0, 0, dm.widthPixels, dm.heightPixels)
    }

    fun showFrame() {
      val f = frame ?: return
      if (f.parent != null) return
      val root = activity.findViewById<ViewGroup>(android.R.id.content)
      root.addView(f, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
      f.bringToFront()
    }

    fun hideFrame() {
      val f = frame ?: return
      (f.parent as? ViewGroup)?.removeView(f) ?: return
      layoutDetached()
    }

    fun next() {
      val job = queue.removeFirstOrNull() ?: run { current = null; return }
      current = job
      val w = ensure()
      // 有的网站按浏览器标识把手机跳到手机版（页面结构不同）：需要时用同版本 Chrome 的电脑版标识
      w.settings.userAgentString = if (job.desktop) desktopUa() else null
      // 平时不加载图片（省流量、更快）；验证码这类需要看图的页面才加载
      w.settings.loadsImagesAutomatically = job.images
      val reset = "window.__readlyOld = 1; window.__readlySig = undefined; window.__readlyFound = 0;"
      if (job.action.isNotEmpty()) {
        // 不换网址：在当前页面里执行操作（例如填好验证码后提交表单），再等新页面
        w.evaluateJavascript("$reset (function(){ ${job.action} })()", null)
      } else {
        // 刚建好的网页还没打开过任何页面：这时执行脚本，回调可能永远不回来（以前第一次加载总要等到超时），直接打开
        if (w.url.isNullOrEmpty() || w.url == "about:blank") w.loadUrl(job.url)
        else w.evaluateJavascript(reset) { w.loadUrl(job.url) }
      }
      main.postDelayed({ poll(job) }, 300)
      // 看门狗：应用切到后台时网页可能被系统暂停，探测脚本的回调永远不回来；到时间还没结束就判超时，
      // 免得这个网页一直被占着（前端会重试）
      fun watchdog() {
        if (current !== job) return
        if (job.challengedAt > 0) { main.postDelayed({ watchdog() }, 5000); return }
        finish(job, "ERR:网页加载超时")
      }
      main.postDelayed({ watchdog() }, job.timeoutMs + 8000)
    }

    fun finish(job: Job, result: String) {
      if (current !== job) return
      synchronized(results) { results[job.id] = result }
      if (job.challengedAt > 0) {
        hideFrame()
        notify("window.__readlyBrowserHidden && window.__readlyBrowserHidden()")
      }
      notify("window.__readlyBrowserDone && window.__readlyBrowserDone(${JSONObject.quote(job.id)})")
      current = null
      next()
    }

    fun poll(job: Job) {
      if (current !== job) return
      if (job.gen != gen) return finish(job, "ERR:已取消")
      val w = web ?: return
      w.evaluateJavascript(job.script) { raw ->
        // 回调给的是 JSON 字符串字面量
        val r = try { org.json.JSONTokener(raw).nextValue() as? String ?: raw } catch (e: Exception) { raw }
        val now = System.currentTimeMillis()
        when {
          r.startsWith("OK:") -> finish(job, r)
          r.startsWith("BLOCKED:") -> finish(job, "ERR:网站暂时拒绝访问（${r.removePrefix("BLOCKED:")}），稍后重试")
          r == "CHALLENGE" -> {
            if (job.challengedAt == 0L) job.challengedAt = now
            // 自动验证一般几秒内就过；超过 4 秒还在，就请用户手动完成
            if (now - job.challengedAt > 4000 && !visible) {
              showFrame()
              notify("window.__readlyBrowserChallenge && window.__readlyBrowserChallenge()")
            }
            if (now - job.challengedAt > 300_000) finish(job, "ERR:人机验证未完成") else main.postDelayed({ poll(job) }, 300)
          }
          job.challengedAt == 0L && now - job.start > job.timeoutMs -> finish(job, "ERR:网页加载超时（$r）")
          else -> main.postDelayed({ poll(job) }, 200)
        }
      }
    }
  }

  /**
   * 只放行书源网站本身和 Cloudflare 验证的请求；广告、统计等第三方请求直接回空，
   * 网页很快就能加载完（下载更快、更省流量），也不会被广告拖住“加载完成”。
   */
  private open inner class BlockingClient : WebViewClient() {
    private val allowed = listOf("linovelib.com", "bilinovel.com", "wenku8.net", "wenku8.com", "wenku8.cc", "readpai.com", "cloudflare.com")
    override fun shouldInterceptRequest(view: WebView, request: android.webkit.WebResourceRequest): android.webkit.WebResourceResponse? {
      val host = request.url.host ?: return null
      if (allowed.any { host == it || host.endsWith(".$it") }) return null
      return android.webkit.WebResourceResponse("text/plain", "utf-8", 204, "Blocked", emptyMap(), java.io.ByteArrayInputStream(ByteArray(0)))
    }
  }

  val visible: Boolean get() = workers.any { it.visible }

  /** 显示网页（登录 / 手动验证）。autoClose：登录成功、网页跳离登录页后自动收起 */
  fun show(url: String?, autoClose: Boolean = false) = main.post {
    val w = workers[0]
    val web = w.ensure()
    if (!url.isNullOrEmpty()) {
      web.settings.loadsImagesAutomatically = true
      web.settings.userAgentString = desktopUa()
      var seenLogin = false
      web.webViewClient = object : BlockingClient() {
        override fun onPageFinished(view: WebView, pageUrl: String?) {
          if (!autoClose || !w.visible) return
          val onLogin = pageUrl?.contains("login") == true
          if (onLogin) seenLogin = true
          else if (seenLogin) main.postDelayed({ hide(); view.webViewClient = BlockingClient() }, 1200)
        }
      }
      web.loadUrl(url)
    }
    w.showFrame()
  }

  fun hide() = main.post {
    workers.forEach { it.hideFrame() }
    notify("window.__readlyBrowserHidden && window.__readlyBrowserHidden()")
  }

  fun load(id: String, url: String, script: String, timeoutMs: Long, desktop: Boolean, action: String, images: Boolean, slot: Int) = main.post {
    val w = workers[slot.coerceIn(0, SLOTS - 1)]
    w.queue.addLast(Job(id, url, script, timeoutMs, desktop, action, images, gen))
    if (w.current == null) w.next()
  }

  /** 取消全部：排队的直接回“已取消”，正在加载的立刻结束 */
  fun cancelAll() = main.post {
    gen++
    for (w in workers) {
      while (true) {
        val j = w.queue.removeFirstOrNull() ?: break
        synchronized(results) { results[j.id] = "ERR:已取消" }
        notify("window.__readlyBrowserDone && window.__readlyBrowserDone(${JSONObject.quote(j.id)})")
      }
      w.web?.stopLoading()
      w.current?.let { w.finish(it, "ERR:已取消") }
    }
  }

  /** 直接回一个错误结果（请求本身不合法时） */
  fun fail(id: String, error: String) = main.post {
    synchronized(results) { results[id] = error }
    notify("window.__readlyBrowserDone && window.__readlyBrowserDone(${JSONObject.quote(id)})")
  }

  /** 取走结果（取一次就删） */
  fun take(id: String): String = synchronized(results) { results.remove(id) ?: "" }

  private fun desktopUa(): String {
    val ua = defaultUa ?: android.webkit.WebSettings.getDefaultUserAgent(activity).also { defaultUa = it }
    val chrome = Regex("""Chrome/[\d.]+""").find(ua)?.value ?: "Chrome/131.0.0.0"
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) $chrome Safari/537.36"
  }
}
