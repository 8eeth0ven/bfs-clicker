package com.bfs.mcp.ime;

import android.inputmethodservice.InputMethodService;
import android.content.*;
import android.view.inputmethod.*;
import android.os.Build;
import android.util.Base64;
import java.nio.*;
import java.nio.charset.*;
import java.security.MessageDigest;
import java.util.HashSet;

/** Explicit shell-only bridge. No network, logs, persistent values or keyboard changes. */
public final class UnicodeIme extends InputMethodService {
    private final HashSet<String> consumed = new HashSet<>();
    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            setResultCode(0); setResultData("BFS_IME_ERROR:START");
            String nonce = intent.getStringExtra("nonce"), app = intent.getStringExtra("app"), data = intent.getStringExtra("data");
            if (nonce == null || !nonce.matches("[a-f0-9]{32}") || consumed.contains(nonce) || data == null || data.length() > 16384) {setResultData("BFS_IME_ERROR:REQUEST");return;}
            EditorInfo info = getCurrentInputEditorInfo(); InputConnection connection = getCurrentInputConnection();
            if (info == null || connection == null || app == null || !app.equals(info.packageName)) { setResultData("BFS_IME_ERROR:EDITOR"); return; }
            try {
                byte[] bytes = Base64.decode(data, Base64.NO_WRAP);
                String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
                if (text.codePointCount(0, text.length()) > 2048 || text.indexOf('\0') >= 0) return;
                if (consumed.size() >= 4096) return;
                consumed.add(nonce); // Before any UI mutation, including a failed commit.
                boolean ok = true;
                connection.beginBatchEdit();
                try {
                    if (intent.getBooleanExtra("replace", false)) ok = connection.performContextMenuAction(android.R.id.selectAll);
                    if (!intent.getBooleanExtra("replace", false)) {
                        int end = intent.getIntExtra("appendAt", -1);
                        if (end < 0 || end > 4096) return;
                        ok = connection.setSelection(end, end);
                    }
                    if (ok) ok = connection.commitText(text, 1);
                } finally { connection.endBatchEdit(); }
                if (!ok) { setResultData("BFS_IME_ERROR:COMMIT"); return; }
                StringBuilder hash = new StringBuilder(); for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) hash.append(String.format("%02x", b & 255));
                setResultCode(-1); setResultData("BFS_IME:" + nonce + ":" + hash);
            } catch (Exception ignored) {setResultData("BFS_IME_ERROR:"+ignored.getClass().getSimpleName());}
        }
    };
    @Override public void onCreate() {
        super.onCreate();
        IntentFilter filter = new IntentFilter("com.bfs.mcp.ime.COMMIT");
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(receiver, filter, "android.permission.DUMP", null, Context.RECEIVER_EXPORTED);
        else registerReceiver(receiver, filter, "android.permission.DUMP", null);
    }
    @Override public void onDestroy() { unregisterReceiver(receiver); super.onDestroy(); }
}
