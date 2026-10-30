// Shell-only helper. The Android dispatcher enforces target UID on every event.
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;
import java.lang.reflect.Method;
public final class TargetTap {
  public static void main(String[] args) throws Exception {
    if (args.length != 3) throw new IllegalArgumentException("expected uid, x, y");
    int uid = Integer.parseInt(args[0]), x = Integer.parseInt(args[1]), y = Integer.parseInt(args[2]);
    if (uid < 10000 || x < 0 || x > 16383 || y < 0 || y > 16383) throw new IllegalArgumentException("invalid arguments");
    Class<?> clazz = Class.forName("android.hardware.input.InputManagerGlobal");
    Object instance = clazz.getMethod("getInstance").invoke(null);
    Method inject = clazz.getMethod("injectInputEvent", Class.forName("android.view.InputEvent"), int.class, int.class);
    long down = SystemClock.uptimeMillis();
    for (int action : new int[]{MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP}) {
      MotionEvent event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, (float)x, (float)y, 0);
      event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
      try {
        if (!Boolean.TRUE.equals(inject.invoke(instance, event, 2, uid))) throw new IllegalStateException("injection_failed");
      } finally { event.recycle(); }
    }
    System.out.println("targeted_tap_complete");
  }
}
