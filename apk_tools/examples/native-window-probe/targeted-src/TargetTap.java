import android.os.SystemClock;import android.view.InputDevice;import android.view.MotionEvent;import java.lang.reflect.Method;
public class TargetTap {
 public static void main(String[] args) throws Exception {
  int uid=Integer.parseInt(args[0]); long t=SystemClock.uptimeMillis();
  Class<?> c=Class.forName("android.hardware.input.InputManagerGlobal");
  Object instance=c.getMethod("getInstance").invoke(null);
  Method inject=c.getMethod("injectInputEvent",Class.forName("android.view.InputEvent"),int.class,int.class);
  for(int action:new int[]{MotionEvent.ACTION_DOWN,MotionEvent.ACTION_UP}){
   MotionEvent event=MotionEvent.obtain(t,SystemClock.uptimeMillis(),action,150f,270f,0);event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
   try {System.out.println("action="+action+" result="+inject.invoke(instance,event,2,uid));}
   catch(Exception e){System.out.println("action="+action+" error="+e.getCause());System.exit(2);}
   finally{event.recycle();}
  }
 }
}
