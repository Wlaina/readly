package com.readly.reader

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.activity.result.contract.ActivityResultContracts
import org.json.JSONArray
import org.json.JSONObject
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File

class MainActivity : TauriActivity() {
  private var immersive = false
  /** 界面此刻是否在前台（决定渲染进程崩溃后是立刻重启，还是等你回来时再冷启动） */
  private var resumedNow = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    // 最早的窗口底色：跟随上次的深浅色（WebView 创建之前的那一瞬间也不闪白）
    val dark = getSharedPreferences("readly", MODE_PRIVATE).getBoolean("dark", false)
    window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(if (dark) 0xFF141413.toInt() else 0xFFF5F4ED.toInt()))
    super.onCreate(savedInstanceState)
    handleIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleIntent(intent)
  }

  /** 注入 window.ReadlyAndroid，供前端控制沉浸模式与系统栏颜色 */
  override fun onWebViewCreate(webView: WebView) {
    webViewRef = webView
    webView.addJavascriptInterface(Bridge(), "ReadlyAndroid")
    // 页面加载前先用上次的深浅色作为底色，深色模式启动不再闪白
    val dark = getSharedPreferences("readly", MODE_PRIVATE).getBoolean("dark", false)
    val bg = if (dark) 0xFF141413.toInt() else 0xFFF5F4ED.toInt()
    webView.setBackgroundColor(bg)
    window.decorView.setBackgroundColor(bg)
    // 切到后台时也保留已经画好的画面：回到前台时直接显示，不用整屏重画（以前封面会先白一下）
    webView.settings.offscreenPreRaster = true
    // wry 在调用本方法之后才挂上它自己的 WebViewClient：排到消息队列后面再接管
    webView.post { guardRenderer(webView) }
  }

  /**
   * 接管“渲染进程没了”这件事。
   * 网页内容跑在单独的渲染进程里；它崩溃或被系统回收时，如果没人处理，安卓会把整个应用一起杀掉
   * （诊断日志里的“崩溃（原生）status 5”就是这个）。接管后：记下原因，然后干净地重启应用，
   * 前端会自动回到刚才在读的书。
   * 其余回调原样转交给 wry 的客户端，网页加载、IPC 都不受影响。
   */
  private fun guardRenderer(webView: WebView) {
    if (Build.VERSION.SDK_INT < 26) return
    val inner = webView.webViewClient
    if (inner is RendererGuard) return
    webView.webViewClient = RendererGuard(inner)
  }

  inner class RendererGuard(private val inner: WebViewClient) : WebViewClient() {
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
      inner.shouldInterceptRequest(view, request)

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
      inner.shouldOverrideUrlLoading(view, request)

    override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) =
      inner.onPageStarted(view, url, favicon)

    override fun onPageFinished(view: WebView, url: String?) = inner.onPageFinished(view, url)

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) =
      inner.onReceivedError(view, request, error)

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
      val crashed = detail.didCrash()
      val foreground = resumedNow
      Log.e("Readly", "渲染进程退出：crashed=$crashed priority=${detail.rendererPriorityAtExit()} foreground=$foreground")
      getSharedPreferences("readly", MODE_PRIVATE).edit()
        .putString(
          "rendererGone",
          JSONObject()
            .put("time", System.currentTimeMillis())
            .put("crashed", crashed)
            .put("priority", detail.rendererPriorityAtExit())
            .put("foreground", foreground)
            .toString(),
        )
        .commit()
      // 这个 WebView 已经不能用了：从界面上拿掉，免得下一次绘制再把应用拖垮
      try {
        (view.parent as? android.view.ViewGroup)?.removeView(view)
        view.destroy()
      } catch (e: Exception) {
        Log.w("Readly", "移除失效的 WebView 失败", e)
      }
      if (webViewRef === view) webViewRef = null
      if (foreground) {
        // 你正在用：交给一个独立的小进程把应用重新打开
        try {
          startActivity(
            Intent(this@MainActivity, RestartActivity::class.java)
              .putExtra(RestartActivity.EXTRA_PID, android.os.Process.myPid())
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
          )
        } catch (e: Exception) {
          Log.e("Readly", "无法重启应用", e)
          android.os.Process.killProcess(android.os.Process.myPid())
        }
      } else {
        // 在后台：安静地结束，不要自己跳到前台；下次打开时是一次冷启动，前端会回到刚才的书
        android.os.Process.killProcess(android.os.Process.myPid())
      }
      return true
    }
  }

  private var webViewRef: WebView? = null
  private var volumeKeys = false

  /** 音量键翻页：开启时拦下音量键（不再调节音量），交给前端翻页 */
  override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
    val code = event.keyCode
    if (volumeKeys && (code == android.view.KeyEvent.KEYCODE_VOLUME_DOWN || code == android.view.KeyEvent.KEYCODE_VOLUME_UP)) {
      if (event.action == android.view.KeyEvent.ACTION_DOWN) {
        val dir = if (code == android.view.KeyEvent.KEYCODE_VOLUME_DOWN) "next" else "prev"
        webViewRef?.post { webViewRef?.evaluateJavascript("window.__readlyVolumeKey && window.__readlyVolumeKey('$dir')", null) }
      }
      return true
    }
    return super.dispatchKeyEvent(event)
  }

  private fun secretKey(): javax.crypto.SecretKey {
    val ks = java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getEntry("readly_secret", null) as? java.security.KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val gen = javax.crypto.KeyGenerator.getInstance(android.security.keystore.KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    gen.init(
      android.security.keystore.KeyGenParameterSpec.Builder(
        "readly_secret",
        android.security.keystore.KeyProperties.PURPOSE_ENCRYPT or android.security.keystore.KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE)
        .build(),
    )
    return gen.generateKey()
  }

  private fun notifyUpdate(p: Double, err: String) {
    webViewRef?.post { webViewRef?.evaluateJavascript("window.__readlyUpdateProgress && window.__readlyUpdateProgress($p, '$err')", null) }
  }

  private fun installApk(file: File) {
    // 安卓 8+：第一次需要允许 Readly 安装应用；没允许时先打开对应的设置页
    if (Build.VERSION.SDK_INT >= 26 && !packageManager.canRequestPackageInstalls()) {
      startActivity(
        Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
      notifyUpdate(-1.0, "need-permission")
      return
    }
    val uri = androidx.core.content.FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
    startActivity(
      Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, "application/vnd.android.package-archive")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
    )
  }

  /** 系统“选择文件夹”，授权后长期有效（重启手机也不用重新授权） */
  private val pickTree = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
    val js = if (uri == null) "null" else {
      try {
        contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
      } catch (e: Exception) {
        Log.w("Readly", "无法持久化文件夹授权", e)
      }
      val name = DocumentsContract.getTreeDocumentId(uri).substringAfterLast(':').substringAfterLast('/').ifBlank { "内部存储" }
      JSONObject().put("uri", uri.toString()).put("name", name).toString()
    }
    webViewRef?.post { webViewRef?.evaluateJavascript("window.__readlyFolderPicked && window.__readlyFolderPicked($js)", null) }
  }

  inner class Bridge {
    @JavascriptInterface
    fun pickFolder() {
      runOnUiThread { pickTree.launch(null) }
    }

    /** 递归列出授权文件夹里的 epub / txt，返回 JSON 数组 */
    @JavascriptInterface
    fun scanFolder(treeUri: String): String {
      val tree = Uri.parse(treeUri)
      val arr = JSONArray()
      fun walk(docId: String, prefix: String, depth: Int) {
        if (depth > 6) return
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
        val cols = arrayOf(
          DocumentsContract.Document.COLUMN_DOCUMENT_ID,
          DocumentsContract.Document.COLUMN_DISPLAY_NAME,
          DocumentsContract.Document.COLUMN_MIME_TYPE,
          DocumentsContract.Document.COLUMN_SIZE,
          DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
        contentResolver.query(children, cols, null, null, null)?.use { c ->
          while (c.moveToNext()) {
            val id = c.getString(0) ?: continue
            val name = c.getString(1) ?: continue
            val mime = c.getString(2) ?: ""
            if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
              if (!name.startsWith(".")) walk(id, "$prefix$name/", depth + 1)
            } else {
              val lower = name.lowercase()
              if (lower.endsWith(".epub") || lower.endsWith(".txt")) {
                arr.put(
                  JSONObject().put("rel", prefix + name).put("size", c.getLong(3)).put("mtime", c.getLong(4)).put("id", id)
                )
              }
            }
          }
        }
      }
      return try {
        walk(DocumentsContract.getTreeDocumentId(tree), "", 0)
        arr.toString()
      } catch (e: Exception) {
        JSONObject().put("error", e.message ?: "无法读取文件夹（授权可能已失效）").toString()
      }
    }

    /** 把文件夹里的一本书复制到缓存目录，返回路径；由 Rust 的 read_cache_file 读取后删除 */
    @JavascriptInterface
    fun copyFolderFile(treeUri: String, docId: String, name: String): String {
      return try {
        val doc = DocumentsContract.buildDocumentUriUsingTree(Uri.parse(treeUri), docId)
        val dir = File(cacheDir, "readly-folder").apply { mkdirs() }
        val out = File(dir, System.nanoTime().toString() + "-" + name.replace(Regex("[\\\\/:*?\"<>|]"), "_"))
        contentResolver.openInputStream(doc)?.use { input -> out.outputStream().use { input.copyTo(it) } } ?: return ""
        out.absolutePath
      } catch (e: Exception) {
        Log.e("Readly", "复制文件失败", e)
        ""
      }
    }

    @JavascriptInterface
    fun releaseFolder(treeUri: String) {
      try {
        contentResolver.releasePersistableUriPermission(Uri.parse(treeUri), Intent.FLAG_GRANT_READ_URI_PERMISSION)
      } catch (_: Exception) {
      }
    }

    @JavascriptInterface
    fun setImmersive(on: Boolean) {
      runOnUiThread { applyImmersive(on) }
    }

    /** 安卓 12+ 的 Material You 动态取色；更早的系统返回空字符串 */
    @JavascriptInterface
    fun getAccentColor(): String {
      if (Build.VERSION.SDK_INT < 31) return ""
      val c = resources.getColor(android.R.color.system_accent1_500, theme)
      return String.format("#%06x", c and 0xffffff)
    }

    /**
     * 动态取色的整套色阶（同一色相，不同明度）。前端从中挑明度最接近默认赤陶橙的那一阶，
     * 避免固定取 500 阶时颜色偏暗偏灰。返回 JSON：{"300":"#..","400":"#..",...}
     */
    /** 系统当前是否为深色模式（直接读系统配置，比 WebView 的 prefers-color-scheme 更及时） */
    /** 用系统浏览器打开网页（发布页等） */
    @JavascriptInterface
    fun openUrl(url: String) {
      if (!url.startsWith("https://") && !url.startsWith("http://")) return
      runOnUiThread {
        try {
          startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
          Log.e("Readly", "无法打开网址", e)
        }
      }
    }

    /** 阅读页打开“音量键翻页”时由前端开启，离开阅读页关闭 */
    @JavascriptInterface
    fun setVolumeKeys(on: Boolean) {
      volumeKeys = on
    }

    /** 用系统分享面板发送文件（诊断日志等）：可以发到微信、QQ，或“保存到文件” */
    @JavascriptInterface
    fun shareFile(path: String, mime: String, title: String) {
      runOnUiThread {
        try {
          val uri = androidx.core.content.FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", File(path))
          val send = Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_SUBJECT, title)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          }
          startActivity(Intent.createChooser(send, title))
        } catch (e: Exception) {
          Log.e("Readly", "分享失败", e)
        }
      }
    }

    /** 用系统 Keystore 加密敏感信息（WebDAV 密码）；密钥只存在这台手机的安全硬件里，不可导出 */
    @JavascriptInterface
    fun protectSecret(plain: String): String = try {
      val c = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
      c.init(javax.crypto.Cipher.ENCRYPT_MODE, secretKey())
      android.util.Base64.encodeToString(c.iv + c.doFinal(plain.toByteArray(Charsets.UTF_8)), android.util.Base64.NO_WRAP)
    } catch (e: Exception) {
      Log.w("Readly", "加密失败", e)
      ""
    }

    /** 解密失败（例如重装应用后密钥已变）返回 "\u0000"，前端会让你重新输入密码 */
    @JavascriptInterface
    fun unprotectSecret(b64: String): String = try {
      val data = android.util.Base64.decode(b64, android.util.Base64.NO_WRAP)
      val c = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
      c.init(javax.crypto.Cipher.DECRYPT_MODE, secretKey(), javax.crypto.spec.GCMParameterSpec(128, data.copyOfRange(0, 12)))
      String(c.doFinal(data.copyOfRange(12, data.size)), Charsets.UTF_8)
    } catch (e: Exception) {
      Log.w("Readly", "解密失败", e)
      "\u0000"
    }

    /**
     * 下载新版 APK 并调起系统安装。进度通过 window.__readlyUpdateProgress(0~1) 通知前端，
     * 出错时传 -1 和错误信息。第一次安装时系统会询问是否允许 Readly 安装应用。
     */
    @JavascriptInterface
    fun downloadAndInstall(url: String) {
      Thread {
        try {
          val out = File(cacheDir, "update.apk")
          val prefs = getSharedPreferences("readly", MODE_PRIVATE)
          // 同一个地址的安装包已经完整下载过（上次没装、或在安装界面退出了）：直接装，不再重新下载
          if (prefs.getString("apkUrl", "") == url && out.length() > 0 && out.length() == prefs.getLong("apkSize", -1) &&
            packageManager.getPackageArchiveInfo(out.absolutePath, 0) != null
          ) {
            notifyUpdate(1.0, "")
            runOnUiThread { installApk(out) }
            return@Thread
          }
          prefs.edit().remove("apkUrl").remove("apkSize").apply()
          // 先写到临时文件，下载完整了再换成正式文件：中途断网、被杀掉都不会留下半个包
          val part = File(cacheDir, "update.apk.part")
          var conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
          conn.instanceFollowRedirects = true
          conn.connectTimeout = 15000
          conn.readTimeout = 30000
          // GitHub 的下载地址会跳转到另一个域名，手动跟随
          var hops = 0
          while (conn.responseCode in 301..308 && hops++ < 5) {
            val next = conn.getHeaderField("Location")
            conn.disconnect()
            conn = java.net.URL(java.net.URL(url), next).openConnection() as java.net.HttpURLConnection
            conn.connectTimeout = 15000
            conn.readTimeout = 30000
          }
          if (conn.responseCode != 200) throw Exception("HTTP ${conn.responseCode}")
          val total = conn.contentLengthLong
          var done = 0L
          var last = 0L
          conn.inputStream.use { input ->
            part.outputStream().use { output ->
              val buf = ByteArray(64 * 1024)
              while (true) {
                val n = input.read(buf)
                if (n < 0) break
                output.write(buf, 0, n)
                done += n
                val now = System.currentTimeMillis()
                if (total > 0 && now - last > 150) {
                  last = now
                  notifyUpdate(done.toDouble() / total, "")
                }
              }
            }
          }
          if (total > 0 && part.length() != total) throw Exception("下载不完整（${part.length()}/$total）")
          out.delete()
          if (!part.renameTo(out)) throw Exception("无法保存安装包")
          prefs.edit().putString("apkUrl", url).putLong("apkSize", out.length()).apply()
          notifyUpdate(1.0, "")
          runOnUiThread { installApk(out) }
        } catch (e: Exception) {
          Log.e("Readly", "下载更新失败", e)
          notifyUpdate(-1.0, (e.message ?: e.javaClass.simpleName).replace("'", " "))
        }
      }.start()
    }

    /**
     * 切到后台时上传本机阅读记录：前端把内容交过来就立刻返回，压缩与上传在原生线程里完成，
     * 网页被系统暂停也不受影响。失败不重试（下次回到前台时前端会再同步一次）。
     */
    @JavascriptInterface
    fun backgroundPut(url: String, auth: String, json: String): Boolean {
      if (!url.startsWith("https://") && !url.startsWith("http://")) return false
      Thread {
        var conn: java.net.HttpURLConnection? = null
        try {
          val buf = java.io.ByteArrayOutputStream()
          java.util.zip.GZIPOutputStream(buf).use { it.write(json.toByteArray(Charsets.UTF_8)) }
          val body = buf.toByteArray()
          conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
          conn.requestMethod = "PUT"
          conn.doOutput = true
          conn.connectTimeout = 10000
          conn.readTimeout = 15000
          conn.setRequestProperty("Authorization", auth)
          conn.setRequestProperty("Content-Type", "application/gzip")
          conn.setFixedLengthStreamingMode(body.size)
          conn.outputStream.use { it.write(body) }
          val code = conn.responseCode
          if (code !in 200..299) Log.w("Readly", "后台上传阅读记录失败：HTTP $code")
        } catch (e: Exception) {
          Log.w("Readly", "后台上传阅读记录失败", e)
        } finally {
          conn?.disconnect()
        }
      }.start()
      return true
    }

    /** 阅读时的屏幕亮度（只影响 Readly 的窗口）：0.02 ~ 1；小于 0 表示跟随系统 */
    @JavascriptInterface
    fun setBrightness(v: Float) {
      runOnUiThread {
        val lp = window.attributes
        lp.screenBrightness = if (v < 0f) android.view.WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE else v.coerceIn(0.01f, 1f)
        window.attributes = lp
      }
    }

    /**
     * 最近几次进程是怎么结束的（安卓 11+）：崩溃、被系统因内存回收、被用户划掉……
     * 写进诊断日志，“突然回到桌面 / 回来后变成重新启动”这类问题就有据可查。返回 JSON 数组，取不到时返回空串。
     */
    /** 上一次渲染进程退出的记录（取出后清除）；没有时返回空串 */
    @JavascriptInterface
    fun takeRendererGone(): String {
      val p = getSharedPreferences("readly", MODE_PRIVATE)
      val v = p.getString("rendererGone", "") ?: ""
      if (v.isNotEmpty()) p.edit().remove("rendererGone").apply()
      return v
    }

    @JavascriptInterface
    fun getExitReasons(): String {
      if (Build.VERSION.SDK_INT < 30) return ""
      return try {
        val am = getSystemService(ACTIVITY_SERVICE) as android.app.ActivityManager
        val arr = JSONArray()
        for (info in am.getHistoricalProcessExitReasons(null, 0, 6)) {
          arr.put(
            JSONObject()
              .put("time", info.timestamp)
              .put("reason", info.reason)
              .put("status", info.status)
              .put("importance", info.importance)
              .put("process", info.processName ?: "")
              .put("desc", info.description ?: "")
              .put("rssKb", info.rss)
          )
        }
        arr.toString()
      } catch (e: Exception) {
        Log.w("Readly", "读取进程退出原因失败", e)
        ""
      }
    }

    @JavascriptInterface
    fun setKeepScreenOn(on: Boolean) {
      runOnUiThread {
        if (on) window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      }
    }

    @JavascriptInterface
    fun isSystemDark(): Boolean = isNight(resources.configuration)

    @JavascriptInterface
    fun getAccentPalette(): String {
      if (Build.VERSION.SDK_INT < 31) return ""
      val ids = mapOf(
        "200" to android.R.color.system_accent1_200,
        "300" to android.R.color.system_accent1_300,
        "400" to android.R.color.system_accent1_400,
        "500" to android.R.color.system_accent1_500,
        "600" to android.R.color.system_accent1_600,
      )
      val json = JSONObject()
      for ((k, id) in ids) json.put(k, String.format("#%06x", resources.getColor(id, theme) and 0xffffff))
      return json.toString()
    }

    @JavascriptInterface
    fun setSystemBarsDark(dark: Boolean) {
      // 记住深浅色，下次启动时 WebView 直接用对应底色
      getSharedPreferences("readly", MODE_PRIVATE).edit().putBoolean("dark", dark).apply()
      runOnUiThread {
        val bg = if (dark) 0xFF141413.toInt() else 0xFFF5F4ED.toInt()
        webViewRef?.setBackgroundColor(bg)
        window.decorView.setBackgroundColor(bg)
        val c = WindowCompat.getInsetsController(window, window.decorView)
        c.isAppearanceLightStatusBars = !dark
        c.isAppearanceLightNavigationBars = !dark
      }
    }
  }

  private fun applyImmersive(on: Boolean) {
    immersive = on
    val c = WindowCompat.getInsetsController(window, window.decorView)
    if (on) {
      // 从屏幕边缘滑动可临时唤出，几秒后自动隐藏
      c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      c.hide(WindowInsetsCompat.Type.systemBars())
    } else {
      c.show(WindowInsetsCompat.Type.systemBars())
    }
  }

  private fun isNight(c: android.content.res.Configuration) =
    (c.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES

  /** 深浅色由我们自己处理（manifest 声明了 uiMode），系统切换时主动告诉前端 */
  override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
    super.onConfigurationChanged(newConfig)
    notifySystemDark(isNight(newConfig))
  }

  override fun onPause() {
    resumedNow = false
    super.onPause()
  }

  override fun onResume() {
    super.onResume()
    resumedNow = true
    // 在后台期间系统可能已切换深浅色（例如定时夜间模式），回到前台时同步一次
    notifySystemDark(isNight(resources.configuration))
  }

  private fun notifySystemDark(dark: Boolean) {
    webViewRef?.post { webViewRef?.evaluateJavascript("window.__readlySystemDark && window.__readlySystemDark($dark)", null) }
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    // 从后台回来时系统会恢复系统栏，需要重新隐藏
    if (hasFocus && immersive) applyImmersive(true)
  }

  /** 旧入口兼容：若系统仍把文件直接交给本页面，也复制后通知前端 */
  private fun handleIntent(intent: Intent?) {
    if (intent == null) return
    if (intent.getBooleanExtra(OpenActivity.EXTRA_OPEN, false)) {
      notifyOpenFiles()
      return
    }
    if (intent.action != Intent.ACTION_VIEW && intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return
    Thread {
      OpenFiles.copy(this, intent)
      runOnUiThread { notifyOpenFiles() }
    }.start()
  }

  /** 让前端立刻去取待打开的文件（回到前台时前端也会自己取一次，双保险） */
  private fun notifyOpenFiles() {
    webViewRef?.post { webViewRef?.evaluateJavascript("window.__readlyOpenFiles && window.__readlyOpenFiles()", null) }
  }
}
