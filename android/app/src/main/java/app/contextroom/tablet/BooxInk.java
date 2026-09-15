package app.contextroom.tablet;

import android.graphics.Rect;
import android.graphics.RectF;
import android.os.Build;
import android.view.MotionEvent;
import android.widget.Toast;
import com.onyx.android.sdk.api.device.epd.EpdController;
import com.onyx.android.sdk.data.note.TouchPoint;
import com.onyx.android.sdk.pen.RawInputCallback;
import com.onyx.android.sdk.pen.TouchHelper;
import com.onyx.android.sdk.pen.data.TouchPointList;
import java.util.ArrayList;
import java.util.Locale;
import org.json.JSONArray;

/**
 * Optional vendor raw-ink path. Hardware preview is reconciled with the retained model at pen-up.
 */
final class BooxInk {
  final InkView view;
  TouchHelper helper;
  boolean enabled, suspended, capturing;
  volatile boolean rawInputActive;
  float strokeScale, strokeX, strokeY, maxPressure = 4096;
  JSONArray points = new JSONArray();

  static boolean supportedDevice() {
    String name = (Build.MANUFACTURER + " " + Build.BRAND).toLowerCase(Locale.ROOT);
    return name.contains("onyx") || name.contains("boox");
  }

  BooxInk(InkView view) {
    this.view = view;
  }

  void enable(boolean value) {
    enabled = value;
    if (value) open();
    else close();
  }

  void open() {
    if (!supportedDevice() || helper != null) return;
    try {
      maxPressure = Math.max(1, EpdController.getMaxTouchPressure());
      helper =
          TouchHelper.create(
              view,
              new RawInputCallback() {
                @Override
                public void onBeginRawDrawing(boolean b, TouchPoint point) {
                  rawInputActive=true;
                  view.post(
                      () -> {
                        view.listener.interaction();
                        view.beginNativeInk();
                        capturing = true;
                        view.drawing = true;
                        strokeScale = view.scale;
                        strokeX = view.offsetX;
                        strokeY = view.offsetY;
                        points = new JSONArray();
                        append(point);
                      });
                }

                @Override
                public void onRawDrawingTouchPointMoveReceived(TouchPoint point) {
                  TouchPoint copy = new TouchPoint(point);
                  view.post(
                      () -> {
                        if (capturing) {
                          append(copy);
                          if (android.os.SystemClock.uptimeMillis() - view.lastDraftTime > 350) {
                            view.lastDraftTime = android.os.SystemClock.uptimeMillis();
                            view.publishRawPrefix(points);
                          }
                        }
                      });
                }

                @Override
                public void onRawDrawingTouchPointListReceived(TouchPointList list) {
                  ArrayList<TouchPoint> copy = new ArrayList<>();
                  for (TouchPoint p : list.getPoints()) copy.add(new TouchPoint(p));
                  view.post(
                      () -> {
                        points = new JSONArray();
                        for (TouchPoint p : copy) append(p);
                      });
                }

                @Override
                public void onEndRawDrawing(boolean b, TouchPoint point) {
                  TouchPoint copy = new TouchPoint(point);
                  view.post(
                      () -> {
                        append(copy);
                        capturing = false;
                        rawInputActive=false;
                        view.drawing = false;
                        if (points.length() > 0) view.publishRawPrefix(points);
                        view.listener.draft(new JSONArray());
                        reconcile();
                      });
                }

                @Override
                public void onBeginRawErasing(boolean b, TouchPoint point) {
                  rawInputActive=true;view.post(()->view.listener.interaction());
                }

                @Override
                public void onEndRawErasing(boolean b, TouchPoint point) {
                  view.post(
                      () -> {
                        rawInputActive=false;
                        view.erase(
                            (point.x - view.offsetX) / view.scale,
                            (point.y - view.offsetY) / view.scale);
                        reconcile();
                      });
                }

                @Override
                public void onRawErasingTouchPointMoveReceived(TouchPoint point) {
                  view.post(
                      () ->
                          view.erase(
                              (point.x - view.offsetX) / view.scale,
                              (point.y - view.offsetY) / view.scale));
                }

                @Override
                public void onRawErasingTouchPointListReceived(TouchPointList points) {}

                @Override
                public void onPenUpRefresh(RectF rect) {
                  view.post(
                      () -> {
                        if (!capturing) reconcile();
                      });
                }
              });
      helper
          .setStrokeWidth(2 * view.scale)
          .setStrokeColor(android.graphics.Color.BLACK)
          .setLimitRect(new Rect(0, 0, view.getWidth(), view.getHeight()), new ArrayList<>())
          .openRawDrawing();
      helper.setStrokeStyle(TouchHelper.STROKE_STYLE_FOUNTAIN);
      helper.setPenUpRefreshEnabled(true);
      helper.setPenUpRefreshTimeMs(80);
      refresh();
    } catch (Throwable e) {
      fail();
    }
  }

  void append(TouchPoint p) {
    try {
      points.put(
          new JSONArray()
              .put((p.x - strokeX) / strokeScale)
              .put((p.y - strokeY) / strokeScale)
              .put(Math.max(0, Math.min(1, p.pressure / maxPressure))));
    } catch (Exception ignored) {
    }
  }

  void reconcile() {
    if (helper == null) return;
    try {
      helper.setRawDrawingEnabled(false);
      view.invalidate();
      view.postDelayed(this::refresh, 100);
    } catch (Throwable e) {
      fail();
    }
  }

  void refresh() {
    if (helper == null) return;
    try {
      helper
          .setLimitRect(new Rect(0, 0, view.getWidth(), view.getHeight()), new ArrayList<>())
          .setStrokeWidth(2 * view.scale)
          .setRawDrawingEnabled(
              enabled
                  && !suspended
                  && view.hasWindowFocus()
                  && view.isShown()
                  && view.tool.equals("ink"));
    } catch (Throwable e) {
      fail();
    }
  }

  boolean handles(MotionEvent e) {
    if (helper == null || !enabled || suspended || !view.tool.equals("ink")) return false;
    try {
      return helper.onTouchEvent(e);
    } catch (Throwable failure) {
      fail();
      return false;
    }
  }

  void close() {
    finishReached();
    rawInputActive=false;
    capturing = false;
    view.drawing = false;
    if (helper != null) {
      try {
        helper.setRawDrawingEnabled(false);
        helper.closeRawDrawing();
      } catch (Throwable ignored) {
      }
      helper = null;
    }
  }

  void fail() {
    enabled = false;
    close();
    view.getContext().getSharedPreferences("ink", 0).edit().putBoolean("boox", false).apply();
    Toast.makeText(
            view.getContext(),
            "Mode BOOX indisponible sur ce firmware. Encre Android active.",
            Toast.LENGTH_LONG)
        .show();
  }

  void finishReached() {
    if (capturing && points.length() > 0) view.publishRawPrefix(points);
    capturing = false; rawInputActive = false; view.drawing = false;
  }
}
