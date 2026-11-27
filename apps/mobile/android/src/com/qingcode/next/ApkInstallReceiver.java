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
      showToast(context, R.string.install_confirm_unavailable);
    } else if (status != PackageInstaller.STATUS_SUCCESS && status != PackageInstaller.STATUS_FAILURE_ABORTED) {
      showToast(context, R.string.install_rejected);
    }
  }

  private static void showToast(Context context, int message) {
    Toast.makeText(context, NativeLocale.string(context, message), Toast.LENGTH_LONG).show();
  }
}
