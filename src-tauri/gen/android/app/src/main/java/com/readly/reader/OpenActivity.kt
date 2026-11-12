package com.readly.reader

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Log
import java.io.File

/**
 * “用 Readly 打开 / 分享到 Readly”的中转页：没有界面，只负责把文件复制到 cache/open-files，
 * 然后把已经在运行的 Readly 主界面切到前台（singleTask 只会有一个主界面实例）。
 *
 * 以前文件管理器直接启动主界面：Readly 在后台时，系统可能为它再建一个主界面实例，
 * 新实例又创建一个 WebView，和后台那个抢同一个应用内核，结果新界面一直空白、只显示背景。
 */
class OpenActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val src = intent
    Thread {
      OpenFiles.copy(this, src)
      runOnUiThread {
        startActivity(
          Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_OPEN, true)
        )
        finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
      }
    }.start()
  }

  companion object {
    const val EXTRA_OPEN = "readly_open_files"
  }
}

object OpenFiles {
  /** 把 intent 里的书复制到 cache/open-files，并把路径追加到 pending.txt，由 Rust 的 take_open_files 取走 */
  fun copy(ctx: Context, intent: Intent?) {
    val uris = mutableListOf<Uri>()
    when (intent?.action) {
      Intent.ACTION_VIEW -> intent.data?.let(uris::add)
      Intent.ACTION_SEND -> {
        val u: Uri? =
          if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
          else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM)
        u?.let(uris::add)
      }
      Intent.ACTION_SEND_MULTIPLE -> {
        val list: List<Uri>? =
          if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
          else @Suppress("DEPRECATION") intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
        list?.let(uris::addAll)
      }
    }
    if (uris.isEmpty()) return
    val dir = File(ctx.cacheDir, "open-files").apply { mkdirs() }
    for (uri in uris) {
      try {
        val out = File(dir, fileNameFor(ctx, uri))
        ctx.contentResolver.openInputStream(uri)?.use { input ->
          out.outputStream().use { input.copyTo(it) }
        } ?: continue
        File(dir, "pending.txt").appendText(out.absolutePath + "\n")
      } catch (e: Exception) {
        Log.e("Readly", "无法读取打开的文件", e)
      }
    }
  }

  private fun fileNameFor(ctx: Context, uri: Uri): String {
    var name: String? = null
    if (uri.scheme == "content") {
      try {
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
          if (c.moveToFirst()) name = c.getString(0)
        }
      } catch (_: Exception) {
      }
    }
    if (name.isNullOrBlank()) name = uri.lastPathSegment?.substringAfterLast('/')
    var safe = (name ?: "book").replace(Regex("[\\\\/:*?\"<>|]"), "_")
    // 有些文件管理器不给扩展名：按 MIME 补上
    if (!safe.lowercase().endsWith(".epub") && !safe.lowercase().endsWith(".txt")) {
      val mime = ctx.contentResolver.getType(uri) ?: ""
      safe += if (mime.startsWith("text/")) ".txt" else ".epub"
    }
    return safe
  }
}
