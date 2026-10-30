package com.example.inventorydemo;
import android.app.Activity;
import android.os.Bundle;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONException;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.EditText;
import android.widget.CheckBox;
import android.widget.Switch;
import android.widget.RadioGroup;
import android.widget.RadioButton;
import android.view.View;
import android.text.InputType;
import android.view.WindowManager;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;

/** Synthetic test app. All actions are manual and use a local demonstration API. */
public class DemoActivity extends Activity {
  TextView result;
  @Override public void onCreate(Bundle saved) {
    super.onCreate(saved);
    if (getIntent().getBooleanExtra("radio_mode", false)) {
      showRadio();
      return;
    }
    if (getIntent().getBooleanExtra("controls_mode", false)) {
      showControls();
      return;
    }
    if (getIntent().getBooleanExtra("notes_mode", false)) {
      showNotes();
      return;
    }
    if (getIntent().getBooleanExtra("workflow_mode", false)) {
      showWorkflow();
      return;
    }
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
  /** Opt-in pure native calculator. The default HTTP demo above is unchanged. */
  void showWorkflow() {
    LinearLayout view = new LinearLayout(this); view.setOrientation(1);
    int top = (int)(96 * getResources().getDisplayMetrics().density);
    view.setPadding(16, top, 16, 24);
    TextView heading = new TextView(this); heading.setText("Parameter workflow fixture"); view.addView(heading);
    final EditText quantity = new EditText(this);
    quantity.setContentDescription("Quantity"); quantity.setSingleLine(true);
    quantity.setInputType(InputType.TYPE_CLASS_NUMBER); view.addView(quantity);
    Button calculate = new Button(this); calculate.setText("Calculate");
    calculate.setContentDescription("Calculate"); view.addView(calculate);
    final TextView total = new TextView(this); total.setContentDescription("total"); total.setText("TOTAL:0"); view.addView(total);
    final TextView clicks = new TextView(this); clicks.setContentDescription("clicks"); clicks.setText("CLICKS:0"); view.addView(clicks);
    final TextView history = new TextView(this); history.setContentDescription("history"); history.setText("HISTORY:"); view.addView(history);
    final int[] count = {0};
    calculate.setOnClickListener(v -> {
      count[0]++; clicks.setText("CLICKS:" + count[0]);
      try {
        int value = Integer.parseInt(quantity.getText().toString());
        if (value < 1 || value > 10) { total.setText("INVALID"); return; }
        int square = value * value; total.setText("TOTAL:" + square);
        history.append(value + "=" + square + ";");
      } catch (NumberFormatException e) { total.setText("INVALID"); }
    });
    setContentView(view);
  }
  /** Opt-in owned local-write fixture. All records live in this debug App. */
  void showNotes() {
    getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN | WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    final SharedPreferences prefs = getSharedPreferences("workflow_notes", MODE_PRIVATE);
    LinearLayout view = new LinearLayout(this); view.setOrientation(1);
    int top = (int)(96 * getResources().getDisplayMetrics().density); view.setPadding(16, top, 16, 24);
    TextView heading = new TextView(this); heading.setText("Trusted notes write fixture"); view.addView(heading);
    final TextView status = new TextView(this); status.setContentDescription("noteStatus"); view.addView(status);
    final TextView count = new TextView(this); count.setContentDescription("noteCount"); view.addView(count);
    final TextView writes = new TextView(this); writes.setContentDescription("writeCount"); view.addView(writes);
    final EditText body = new EditText(this); body.setContentDescription("NoteBody"); body.setSingleLine(true); view.addView(body);
    Button create = new Button(this); create.setText("Create note"); create.setContentDescription("CreateNote"); view.addView(create);
    Button update = new Button(this); update.setText("Update last note"); update.setContentDescription("UpdateLastNote"); view.addView(update);
    Button clear = new Button(this); clear.setText("Clear owned notes"); clear.setContentDescription("ClearNotes"); view.addView(clear);
    final TextView history = new TextView(this); history.setContentDescription("noteHistory"); view.addView(history);
    final Runnable refresh = () -> {
      JSONArray records = readNotes(prefs);
      status.setText(prefs.getString("last_status", "READY")); count.setText("COUNT:" + records.length());
      writes.setText("WRITES:" + prefs.getInt("write_count", 0)); history.setText("NOTES:" + records.toString());
    };
    create.setOnClickListener(v -> {
      String value = body.getText().toString(); JSONArray records = readNotes(prefs); records.put(value);
      // This value deliberately persists the record but withholds a matching
      // acknowledgement, to prove a failed write is not automatically retried.
      String acknowledged = value.equals("unacknowledged") ? "PENDING" : "SAVED:" + value;
      if (!prefs.edit().putString("records", records.toString()).putInt("write_count", prefs.getInt("write_count", 0) + 1).putString("last_status", acknowledged).commit()) status.setText("COMMIT_FAILED");
      else refresh.run();
    });
    update.setOnClickListener(v -> {
      JSONArray records = readNotes(prefs); if (records.length() == 0) { status.setText("EMPTY"); return; }
      try {
        String value = body.getText().toString(); records.put(records.length() - 1, value);
        if (!prefs.edit().putString("records", records.toString()).putInt("write_count", prefs.getInt("write_count", 0) + 1).putString("last_status", "UPDATED:" + value).commit()) status.setText("COMMIT_FAILED");
        else refresh.run();
      } catch (JSONException e) { status.setText("INVALID"); }
    });
    clear.setOnClickListener(v -> {
      if (!prefs.edit().putString("records", "[]").putInt("write_count", prefs.getInt("write_count", 0) + 1).putString("last_status", "CLEARED").commit()) status.setText("COMMIT_FAILED");
      else refresh.run();
    });
    refresh.run(); setContentView(view);
  }
  /** Opt-in native bool filters; counters instrument only this owned fixture. */
  void showControls() {
    getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN | WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    LinearLayout view = new LinearLayout(this); view.setOrientation(1);
    int top = (int)(96 * getResources().getDisplayMetrics().density); view.setPadding(16, top, 16, 24);
    view.setContentDescription("ControlFilters");
    TextView heading = new TextView(this); heading.setText("Native boolean query fixture"); view.addView(heading);
    final TextView result = new TextView(this); result.setContentDescription("ControlsResult"); result.setText("RESULT:waiting"); view.addView(result);
    final TextView counts = new TextView(this); view.addView(counts);
    final EditText query = new EditText(this); query.setContentDescription("QueryText"); query.setSingleLine(true);
    query.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
    final CheckBox archived = new CheckBox(this); archived.setText("Include archived");
    archived.setContentDescription(getIntent().getBooleanExtra("controls_drift", false) ? "IncludeArchivedChanged" : "IncludeArchived"); view.addView(archived);
    final Switch active = new Switch(this); active.setText("Only active"); active.setContentDescription("OnlyActive"); view.addView(active); view.addView(query);
    final Button search = new Button(this); search.setText("Search"); search.setContentDescription("ControlsSearch"); view.addView(search);
    final TextView history = new TextView(this); view.addView(history);
    final int[] counters = {0, 0, 0};
    final Runnable refresh = () -> counts.setText("QUERIES:" + counters[0] + ";ARCHIVED_TAPS:" + counters[1] + ";ACTIVE_TAPS:" + counters[2]);
    archived.setOnClickListener(v -> { counters[1]++; refresh.run(); });
    active.setOnClickListener(v -> { counters[2]++; refresh.run(); });
    search.setOnClickListener(v -> {
      counters[0]++; String snapshot = "q=" + query.getText().toString() + ";archived=" + archived.isChecked() + ";active=" + active.isChecked() + ";queryId=" + counters[0];
      result.setText("RESULT:" + snapshot); history.append(snapshot + "\n"); refresh.run();
    });
    refresh.run(); setContentView(view);
  }
  /** Opt-in real RadioGroup query fixture with explicit structural negatives. */
  void showRadio() {
    getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN | WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    LinearLayout view = new LinearLayout(this); view.setOrientation(1); view.setContentDescription("RadioFilters");
    int top = (int)(96 * getResources().getDisplayMetrics().density); view.setPadding(16, top, 16, 24);
    TextView heading = new TextView(this); heading.setText("Native radio query fixture"); view.addView(heading);
    final TextView result = new TextView(this); result.setContentDescription("RadioResult"); result.setText("RESULT:waiting"); view.addView(result);
    final TextView counts = new TextView(this); view.addView(counts);
    final RadioGroup group = new RadioGroup(this); group.setOrientation(RadioGroup.HORIZONTAL); group.setContentDescription("StatusGroup"); view.addView(group);
    final RadioButton all = new RadioButton(this); all.setText("All"); all.setContentDescription("all"); all.setId(View.generateViewId());
    final RadioButton open = new RadioButton(this); open.setText("Open"); open.setContentDescription("open"); open.setId(View.generateViewId());
    final RadioButton closed = new RadioButton(this); closed.setText("Closed"); closed.setContentDescription("closed"); closed.setId(View.generateViewId());
    String drift = getIntent().getStringExtra("radio_drift");
    if ("unique".equals(drift)) {
      // RadioGroup coordinates its direct RadioButton children only. Nesting
      // these owned buttons intentionally makes a real malformed group with
      // two checked descendants, for the live fail-closed preflight test.
      LinearLayout nested = new LinearLayout(this); nested.setOrientation(LinearLayout.HORIZONTAL); group.addView(nested);
      nested.addView(all); nested.addView(open); nested.addView(closed); all.setChecked(true); open.setChecked(true);
    } else {
      group.addView(all); group.addView(open);
      if ("cross".equals(drift)) {
        RadioGroup other = new RadioGroup(this); other.setContentDescription("OtherStatusGroup"); other.addView(closed); view.addView(other); other.check(closed.getId());
      } else group.addView(closed);
      group.check(all.getId());
    }
    final EditText query = new EditText(this); query.setContentDescription("RadioQueryText"); query.setSingleLine(true);
    query.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS); view.addView(query);
    final Button search = new Button(this); search.setText("Search"); search.setContentDescription("RadioSearch"); view.addView(search);
    final TextView history = new TextView(this); view.addView(history);
    final int[] counters = {0, 0, 0, 0};
    final Runnable refresh = () -> counts.setText("QUERIES:" + counters[0] + ";ALL:" + counters[1] + ";OPEN:" + counters[2] + ";CLOSED:" + counters[3]);
    all.setOnClickListener(v -> { counters[1]++; refresh.run(); });
    open.setOnClickListener(v -> { counters[2]++; refresh.run(); });
    closed.setOnClickListener(v -> { counters[3]++; refresh.run(); });
    search.setOnClickListener(v -> {
      counters[0]++; String alias = group.getCheckedRadioButtonId() == all.getId() ? "all" : group.getCheckedRadioButtonId() == open.getId() ? "open" : group.getCheckedRadioButtonId() == closed.getId() ? "closed" : "invalid";
      String snapshot = "q=" + query.getText().toString() + ";status=" + alias + ";queryId=" + counters[0];
      result.setText("RESULT:" + snapshot); history.append(snapshot + "\n"); refresh.run();
    });
    refresh.run(); setContentView(view);
  }
  JSONArray readNotes(SharedPreferences prefs) {
    try { return new JSONArray(prefs.getString("records", "[]")); }
    catch (JSONException e) { return new JSONArray(); }
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
