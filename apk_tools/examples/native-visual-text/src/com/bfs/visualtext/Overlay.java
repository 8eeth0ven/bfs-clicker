package com.bfs.visualtext;
import android.app.Activity;import android.os.Bundle;import android.view.*;import android.graphics.Color;
public final class Overlay extends Activity {public void onCreate(Bundle b){super.onCreate(b);getWindow().setFlags(1024,1024);View v=new View(this);v.setBackgroundColor(Color.TRANSPARENT);v.setOnTouchListener((w,e)->{if(e.getAction()==0)android.util.Log.i("BFS-TEXT-PROBE","OVERLAY_DOWN");return true;});setContentView(v);}}
