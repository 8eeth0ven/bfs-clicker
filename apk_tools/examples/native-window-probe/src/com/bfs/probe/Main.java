package com.bfs.probe;
import android.app.Activity;import android.os.Bundle;import android.view.*;import android.graphics.*;
public class Main extends Activity {public void onCreate(Bundle b){super.onCreate(b);getWindow().setFlags(1024,1024);setContentView(new View(this){ Paint p=new Paint(); protected void onDraw(Canvas c){c.drawColor(Color.WHITE);p.setColor(Color.BLACK);p.setTextSize(72);c.drawText("Search",100,300,p);} public boolean onTouchEvent(android.view.MotionEvent e){if(e.getAction()==0)android.util.Log.i("BFS-PROBE","MAIN_DOWN");return true;} });}}
