package com.qingcode.next;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.BooleanSupplier;

final class ActivityRequests {
  private final Activity activity;
  private final BooleanSupplier canShowUi;
  private CompletableFuture<Intent> pending;
  private int requestCode = 1000;
  private boolean closed;

  ActivityRequests(Activity activity, BooleanSupplier canShowUi) {
    this.activity = activity;
    this.canShowUi = canShowUi;
  }

  Intent choose(Intent intent, String unavailableCode, String unavailableMessage) throws Exception {
    CompletableFuture<Intent> result = new CompletableFuture<>();
    int code;
    synchronized (this) {
      if (closed) throw new BridgeException("internal", "应用已关闭");
      if (pending != null) throw new BridgeException("picker_busy", "请先关闭当前系统选择界面");
      code = requestCode = requestCode >= 65534 ? 1000 : requestCode + 1;
      pending = result;
    }
    try {
      activity.runOnUiThread(() -> {
        if (result.isDone()) return;
        if (!canShowUi.getAsBoolean()) {
          result.completeExceptionally(new BridgeException("picker", "请回到 QingCode 页面后重试"));
          return;
        }
        try {
          activity.startActivityForResult(intent, code);
        } catch (ActivityNotFoundException | SecurityException error) {
          result.completeExceptionally(new BridgeException(unavailableCode, unavailableMessage));
        } catch (RuntimeException error) {
          result.completeExceptionally(new BridgeException("picker", "无法打开系统选择界面"));
        }
      });
      return result.get(5, TimeUnit.MINUTES);
    } catch (TimeoutException error) {
      result.cancel(false);
      activity.runOnUiThread(() -> activity.finishActivity(code));
      throw new BridgeException("picker_timeout", "系统选择界面已超时，请重试");
    } catch (ExecutionException error) {
      if (error.getCause() instanceof BridgeException) throw (BridgeException) error.getCause();
      throw new BridgeException("picker", "打开系统选择界面失败");
    } finally {
      synchronized (this) {
        if (pending == result) pending = null;
      }
    }
  }

  synchronized boolean receive(int code, int resultCode, Intent data) {
    if (code != requestCode || pending == null) return false;
    pending.complete(resultCode == Activity.RESULT_OK ? data : null);
    return true;
  }

  synchronized void close() {
    closed = true;
    if (pending != null) pending.completeExceptionally(new BridgeException("internal", "应用已关闭"));
  }
}
