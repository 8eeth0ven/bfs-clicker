package com.bfs.mcp.ime;
import android.app.Activity;
import android.os.Bundle;
import android.widget.*;
public class UnicodeActivity extends Activity {
 int count;
 public void onCreate(Bundle state){super.onCreate(state);LinearLayout form=new LinearLayout(this);form.setOrientation(1);form.setOnApplyWindowInsetsListener((v,insets)->{v.setPadding(insets.getSystemWindowInsetLeft()+16,insets.getSystemWindowInsetTop()+16,insets.getSystemWindowInsetRight()+16,insets.getSystemWindowInsetBottom()+16);return insets;});form.setContentDescription("QueryForm");EditText query=new EditText(this);query.setContentDescription("UnicodeQuery");query.setSingleLine(true);Button search=new Button(this);search.setText("Search");search.setContentDescription("UnicodeSearch");TextView result=new TextView(this);result.setContentDescription("UnicodeResult");result.setText("RESULT:waiting;COUNT:0");search.setOnClickListener(v->{count++;result.setText("RESULT:q="+query.getText()+";COUNT:"+count);});form.addView(query);form.addView(search);form.addView(result);setContentView(form);}
}
