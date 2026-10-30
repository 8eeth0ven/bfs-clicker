package com.bfs.visualtext;
import android.app.Activity;import android.os.Bundle;import android.content.*;import android.graphics.*;import android.text.*;import android.view.*;import android.view.inputmethod.*;
public final class Main extends Activity {
 DrawnEditor editor;final BroadcastReceiver modeReceiver=new BroadcastReceiver(){@Override public void onReceive(Context c,Intent i){String mode=i.getStringExtra("mode");editor.ignoreInput="ignore".equals(mode);editor.autoResult="auto".equals(mode);editor.ignoreSubmit="auto".equals(mode);setResultCode(-1);}};
 @Override public void onCreate(Bundle state){super.onCreate(state);getWindow().setFlags(1024,1024);editor=new DrawnEditor(this);setContentView(editor);registerReceiver(modeReceiver,new IntentFilter("com.bfs.visualtext.MODE"),"android.permission.DUMP",null,Context.RECEIVER_EXPORTED);}
 @Override public void onDestroy(){unregisterReceiver(modeReceiver);super.onDestroy();}
 static final class DrawnEditor extends View {
  final Paint paint=new Paint();final SpannableStringBuilder value=new SpannableStringBuilder("OLDVALUE");boolean ignoreInput,autoResult,ignoreSubmit;String result="waiting";
  DrawnEditor(Context context){super(context);setFocusable(true);setFocusableInTouchMode(true);}
  @Override public boolean onCheckIsTextEditor(){return true;}
  @Override public InputConnection onCreateInputConnection(EditorInfo info){info.inputType=android.text.InputType.TYPE_CLASS_TEXT;info.imeOptions=EditorInfo.IME_ACTION_DONE;return new BaseInputConnection(this,true){
   @Override public Editable getEditable(){return value;}
   @Override public boolean performContextMenuAction(int id){if(id==android.R.id.selectAll){Selection.setSelection(value,0,value.length());return true;}return false;}
   @Override public boolean commitText(CharSequence text,int position){if(ignoreInput){android.util.Log.i("BFS-TEXT-PROBE","IGNORED_COMMIT");return true;}boolean ok=super.commitText(text,position);if(autoResult)result=value.toString();postInvalidate();return ok;}
  };}
  @Override protected void onDraw(Canvas canvas){canvas.drawColor(Color.WHITE);paint.setColor(Color.BLACK);paint.setTextSize(64);canvas.drawText("Query",40,190,paint);canvas.drawText(value.toString(),270,190,paint);canvas.drawText("Search",40,400,paint);canvas.drawText("RESULT "+result,40,700,paint);}
  @Override public boolean onTouchEvent(android.view.MotionEvent event){if(event.getAction()!=MotionEvent.ACTION_UP)return true;float y=event.getY();if(y>=90&&y<230){requestFocus();((InputMethodManager)getContext().getSystemService(Context.INPUT_METHOD_SERVICE)).showSoftInput(this,0);}else if(y>=320&&y<430){if(ignoreSubmit)android.util.Log.i("BFS-TEXT-PROBE","IGNORED_SEARCH");else{android.util.Log.i("BFS-TEXT-PROBE","SEARCH");result=value.toString();invalidate();}}return true;}
 }
}
