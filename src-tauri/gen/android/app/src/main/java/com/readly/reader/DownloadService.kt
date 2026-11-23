package com.readly.reader

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * 书库下载进行中时的前台服务：让系统不要在切后台 / 熄屏后冻结或回收 Readly，并持有 CPU 唤醒锁，
 * 下载（由网页里的代码驱动）才能在后台继续。通知栏显示进度，点一下回到 Readly。
 * 下载全部结束后由前端调用 stop()。
 */
class DownloadService : Service() {
  companion object {
    private const val CHANNEL = "readly_download"
    private const val ID = 41
    private const val EXTRA_TEXT = "text"
    @Volatile var running = false

    fun update(ctx: Context, text: String) {
      val i = Intent(ctx, DownloadService::class.java).putExtra(EXTRA_TEXT, text)
      try {
        if (!running && Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
      } catch (e: Exception) {
        android.util.Log.w("Readly", "前台服务启动失败", e)
      }
    }

    fun stop(ctx: Context) {
      if (running) ctx.stopService(Intent(ctx, DownloadService::class.java))
    }
  }

  private var wake: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  private fun build(text: String): Notification {
    val nm = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
      nm.createNotificationChannel(NotificationChannel(CHANNEL, "书库下载", NotificationManager.IMPORTANCE_LOW))
    }
    val open = PendingIntent.getActivity(
      this, 0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
    return b.setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle("Readly 正在下载")
      .setContentText(text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setContentIntent(open)
      .build()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: ""
    val n = build(text)
    if (!running) {
      if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      else startForeground(ID, n)
      running = true
      // 熄屏后 CPU 也要醒着；最多 2 小时，防止忘了释放
      wake = (getSystemService(Context.POWER_SERVICE) as PowerManager)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Readly:download")
        .apply { acquire(2 * 60 * 60 * 1000L) }
    } else {
      getSystemService(NotificationManager::class.java).notify(ID, n)
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    wake?.let { if (it.isHeld) it.release() }
    wake = null
    super.onDestroy()
  }
}
