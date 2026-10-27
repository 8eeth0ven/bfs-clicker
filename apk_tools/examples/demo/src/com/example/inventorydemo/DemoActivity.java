package com.example.inventorydemo;
import android.app.Activity;
import android.os.Bundle;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;

/** Synthetic test app. All actions are manual and use a local demonstration API. */
public class DemoActivity extends Activity {
  TextView result;
  @Override public void onCreate(Bundle saved) {
    super.onCreate(saved);
    LinearLayout view = new LinearLayout(this); view.setOrientation(1);
    int top = (int)(96 * getResources().getDisplayMetrics().density);
    view.setPadding(16, top, 16, 24);
    result = new TextView(this); result.setText("Local inventory fixture; tap a request.");
    for (String method : new String[]{"GET", "POST"}) {
      Button button = new Button(this); button.setText(method + " /items");
      button.setOnClickListener(v -> new Thread(() -> request(method)).start()); view.addView(button);
    }
    view.addView(result); setContentView(view);
  }
  void request(String method) {
    String base = getIntent().getStringExtra("base_url"); if (base == null) base = "http://127.0.0.1:8765";
    String proxyHost = getIntent().getStringExtra("proxy_host"); if (proxyHost == null) proxyHost = "10.0.2.2";
    int proxyPort = getIntent().getIntExtra("proxy_port", 8080);
    try {
      Proxy proxy = new Proxy(Proxy.Type.HTTP, new InetSocketAddress(proxyHost, proxyPort));
      HttpURLConnection c = (HttpURLConnection) new URL(base + "/items?page=1").openConnection(proxy);
      c.setRequestMethod(method); c.setConnectTimeout(3000); c.setReadTimeout(3000);
      if (method.equals("POST")) {
        c.setDoOutput(true); c.setRequestProperty("Content-Type", "application/json");
        try (java.io.OutputStream out = c.getOutputStream()) {out.write("{\"title\":\"fixture\"}".getBytes("UTF-8"));}
      }
      final String message = method + ": " + c.getResponseCode(); c.disconnect();
      runOnUiThread(() -> result.setText(message));
    } catch (Exception e) { runOnUiThread(() -> result.setText("Request unavailable: " + e.getClass().getSimpleName())); }
  }
}
