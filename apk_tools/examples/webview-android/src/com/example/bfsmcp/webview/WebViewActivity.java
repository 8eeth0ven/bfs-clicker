package com.example.bfsmcp.webview;

import android.app.Activity;
import android.os.Bundle;
import android.os.Process;
import android.util.AtomicFile;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/** Self-contained, inspectable, loopback-only test app. No third-party traffic. */
public final class WebViewActivity extends Activity {
    private final Object ledgerLock = new Object();
    private WebView view;
    private ServerSocket server;
    private File ledger;
    private String pageUrl;
    private volatile boolean stopping;

    private static byte[] all(InputStream stream) throws Exception {
        try (InputStream input = stream; ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) >= 0) {
                if (bytes.size() + count > 1024 * 1024) throw new Exception("bounded fixture file");
                bytes.write(buffer, 0, count);
            }
            return bytes.toByteArray();
        }
    }

    private static void persist(File target, byte[] bytes) throws Exception {
        AtomicFile atomic = new AtomicFile(target);
        FileOutputStream output = atomic.startWrite();
        try { output.write(bytes); output.getFD().sync(); atomic.finishWrite(output); }
        catch (Exception error) { atomic.failWrite(output); throw error; }
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        ledger = new File(getFilesDir(), "webview-ledger.json");
        try {
            synchronized (ledgerLock) {
                if (!ledger.exists()) persist(ledger, "[]".getBytes(StandardCharsets.UTF_8));
                new JSONArray(new String(all(new FileInputStream(ledger)), StandardCharsets.UTF_8));
            }
            int port = getIntent().getIntExtra("fixturePort", 20127);
            if (port < 1024 || port > 65535) throw new Exception("fixture port");
            server = new ServerSocket(port, 8, InetAddress.getByName("127.0.0.1"));
            pageUrl = "http://127.0.0.1:" + port + "/form";
            Thread serving = new Thread(this::serve, "bfs-owned-loopback");
            serving.setDaemon(true); serving.start();
            WebView.setWebContentsDebuggingEnabled(true);
            view = new WebView(this);
            view.getSettings().setJavaScriptEnabled(true);
            view.getSettings().setAllowFileAccess(false);
            view.getSettings().setAllowContentAccess(false);
            view.addJavascriptInterface(new SubmitBridge(), "BfsNative");
            view.setWebViewClient(new WebViewClient() {
                @Override public boolean shouldOverrideUrlLoading(WebView web, WebResourceRequest request) {
                    return !pageUrl.equals(request.getUrl().toString());
                }
            });
            setContentView(view);
            JSONObject ready = new JSONObject().put("package", getPackageName()).put("pid", Process.myPid())
                .put("url", pageUrl).put("port", port).put("ledgerInitialized", true);
            persist(new File(getFilesDir(), "fixture-ready.json"), ready.toString().getBytes(StandardCharsets.UTF_8));
            view.loadUrl(pageUrl);
        } catch (Exception error) { fail(error); }
    }

    private void fail(Exception error) {
        try { persist(new File(getFilesDir(), "fixture-error.json"),
            new JSONObject().put("type", error.getClass().getName()).put("message", String.valueOf(error.getMessage()))
                .toString().getBytes(StandardCharsets.UTF_8)); }
        catch (Exception ignored) { }
    }

    public final class SubmitBridge {
        @JavascriptInterface public void submit(String query, String detail) {
            try {
                if (query == null || detail == null || query.length() > 4096 || detail.length() > 4096)
                    throw new Exception("fixture input bound");
                final JSONObject row;
                synchronized (ledgerLock) {
                    JSONArray entries = new JSONArray(new String(all(new FileInputStream(ledger)), StandardCharsets.UTF_8));
                    row = new JSONObject().put("query", query).put("detail", detail).put("count", entries.length() + 1);
                    entries.put(row);
                    persist(ledger, entries.toString().getBytes(StandardCharsets.UTF_8));
                }
                runOnUiThread(() -> view.evaluateJavascript("window.bfsFixtureAck(" + row.toString() + ")", null));
            } catch (Exception error) { fail(error); }
        }
    }

    private void serve() {
        while (!stopping) {
            try (Socket socket = server.accept()) {
                socket.setSoTimeout(3000);
                BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
                String first = reader.readLine();
                if (first == null || first.length() > 8192) continue;
                String[] parts = first.split(" "); int total = first.length(); String line;
                while ((line = reader.readLine()) != null && !line.isEmpty()) {
                    total += line.length(); if (total > 16384) throw new Exception("fixture request bound");
                }
                boolean okay = parts.length == 3 && parts[0].equals("GET") && parts[1].equals("/form");
                byte[] body = okay ? all(getAssets().open("form.html")) : "not found".getBytes(StandardCharsets.UTF_8);
                OutputStream output = socket.getOutputStream();
                output.write(((okay ? "HTTP/1.1 200 OK\r\n" : "HTTP/1.1 404 Not Found\r\n")
                    + "Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: "
                    + body.length + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                output.write(body); output.flush();
            } catch (Exception error) { if (!stopping) fail(error); }
        }
    }

    @Override public void onDestroy() {
        stopping = true;
        try { if (server != null) server.close(); } catch (Exception ignored) { }
        if (view != null) { view.removeJavascriptInterface("BfsNative"); view.destroy(); }
        super.onDestroy();
    }
}
