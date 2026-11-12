package com.readly.reader

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * 在独立的小进程（:restart）里把 Readly 重新打开。
 * 主进程的网页渲染进程崩溃后，主进程本身也已经不可用了；自己杀掉自己再启动会被一起带走，
 * 所以交给这个进程来做：先结束主进程，再启动主界面，最后自己退出。
 */
class RestartActivity : Activity() {
  companion object {
    const val EXTRA_PID = "pid"
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val pid = intent.getIntExtra(EXTRA_PID, -1)
    if (pid > 0) android.os.Process.killProcess(pid)
    packageManager.getLaunchIntentForPackage(packageName)?.let {
      startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
    }
    finish()
    Runtime.getRuntime().exit(0)
  }
}
