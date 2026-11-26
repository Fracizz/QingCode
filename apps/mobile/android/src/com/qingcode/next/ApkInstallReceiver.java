package com.qingcode.next;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.widget.Toast;

public final class ApkInstallReceiver extends BroadcastReceiver {
  @SuppressWarnings("deprecation")
  @Override public void onReceive(Context context, Intent intent) {
    int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
    if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
      Intent confirmation = Build.VERSION.SDK_INT >= 33
        ? intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class) : intent.getParcelableExtra(Intent.EXTRA_INTENT);
      if (confirmation != null) {
        try {
          context.startActivity(confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
          return;
        } catch (RuntimeException ignored) {
          // 返回到应用前台时可以再次请求安装。
        }
      }
      Toast.makeText(context, "无法打开系统安装确认，请回到应用重试", Toast.LENGTH_LONG).show();
    } else if (status != PackageInstaller.STATUS_SUCCESS && status != PackageInstaller.STATUS_FAILURE_ABORTED) {
      Toast.makeText(context, "Android 拒绝安装此更新", Toast.LENGTH_LONG).show();
    }
  }
}
