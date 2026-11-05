package com.bfs.mcp.nativebranches;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.TextView;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/** Synthetic, local-only query app. The manifest intentionally has no INTERNET permission. */
public final class BranchActivity extends Activity {
    private SharedPreferences store;
    private String page = "first", currentQuery = "", currentRoute = "left";

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        store = getSharedPreferences("submissions", MODE_PRIVATE);
        if (!store.contains("count") && !store.edit().putInt("count", 0).putInt("nextCount", 0)
                .putInt("detailChanges", 0).putBoolean("faultArmed", false).putString("entries", "[]").commit())
            throw new IllegalStateException("Store failure");
        persistState();
        showEntry();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Explicit negative-test setup: arm exactly one wrong route without
        // changing the current screen or the independent submission ledger.
        if (intent.getBooleanExtra("flip_next_route", false)) {
            if (!store.edit().putBoolean("faultArmed", true).commit()) throw new IllegalStateException("Store failure");
            persistState();
        }
    }

    private LinearLayout form(int id) {
        LinearLayout root = new LinearLayout(this);
        root.setId(id);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setFocusableInTouchMode(true);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft() + 16, insets.getSystemWindowInsetTop() + 16,
                    insets.getSystemWindowInsetRight() + 16, insets.getSystemWindowInsetBottom() + 16);
            return insets;
        });
        return root;
    }

    private EditText field(int id) {
        EditText input = new EditText(this);
        input.setId(id);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        input.setSelectAllOnFocus(false);
        return input;
    }

    private Button button(int id, String title) {
        Button button = new Button(this);
        button.setId(id);
        button.setText(title);
        return button;
    }

    private void display(LinearLayout root) {
        setContentView(root);
        root.requestFocus();
    }

    private void hideInput(View input) {
        ((InputMethodManager)getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(input.getWindowToken(), 0);
        input.clearFocus();
    }

    private void showEntry() {
        page = "first";
        LinearLayout root = form(R.id.entry_form);
        EditText query = field(R.id.query);
        RadioGroup route = new RadioGroup(this);
        route.setId(R.id.route);
        route.setOrientation(RadioGroup.HORIZONTAL);
        RadioButton left = new RadioButton(this), right = new RadioButton(this);
        left.setId(R.id.left); left.setText("left");
        right.setId(R.id.right); right.setText("right");
        route.addView(left); route.addView(right); route.check(R.id.left);
        Button next = button(R.id.next, "Next");
        next.setOnClickListener(view -> {
            currentQuery = query.getText().toString();
            currentRoute = route.getCheckedRadioButtonId() == R.id.right ? "right" : "left";
            boolean flip = store.getBoolean("faultArmed", false);
            if (!store.edit().putInt("nextCount", store.getInt("nextCount", 0) + 1)
                    .putBoolean("faultArmed", false).commit()) throw new IllegalStateException("Store failure");
            if (flip) currentRoute = "left".equals(currentRoute) ? "right" : "left";
            hideInput(query);
            persistState();
            showDetail();
        });
        root.addView(query); root.addView(route); root.addView(next);
        display(root);
    }

    private void showDetail() {
        boolean left = "left".equals(currentRoute);
        page = currentRoute;
        LinearLayout root = form(left ? R.id.left_form : R.id.right_form);
        EditText detail = field(left ? R.id.detail : R.id.alternate_detail);
        detail.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence value, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence value, int start, int before, int count) {}
            @Override public void afterTextChanged(Editable value) {
                if (!store.edit().putInt("detailChanges", store.getInt("detailChanges", 0) + 1).commit()) throw new IllegalStateException("Store failure");
                persistState();
            }
        });
        Button search = button(left ? R.id.left_search : R.id.right_search, "Search " + currentRoute);
        search.setOnClickListener(view -> {
            String value = detail.getText().toString();
            hideInput(detail);
            submit(value);
        });
        root.addView(detail); root.addView(search);
        display(root);
    }

    private void submit(String detail) {
        try {
            JSONArray entries = new JSONArray(store.getString("entries", "[]"));
            int count = store.getInt("count", 0) + 1;
            JSONObject entry = new JSONObject();
            entry.put("number", count); entry.put("route", currentRoute);
            entry.put("query", currentQuery); entry.put("detail", detail);
            entries.put(entry);
            if (!store.edit().putInt("count", count).putString("entries", entries.toString()).commit())
                throw new IllegalStateException("Store failure");
            persistState();
            page = currentRoute + "_result";
            boolean left = "left".equals(currentRoute);
            LinearLayout root = form(left ? R.id.left_result_form : R.id.right_result_form);
            TextView result = new TextView(this);
            result.setId(left ? R.id.left_result : R.id.right_result);
            result.setText("RESULT " + currentQuery + " / " + detail + " / " + currentRoute + " ;COUNT:" + count);
            root.addView(result);
            display(root);
        } catch (Exception error) { throw new IllegalStateException(error); }
    }

    private void persistState() {
        try {
            JSONObject state = new JSONObject();
            state.put("count", store.getInt("count", 0));
            state.put("nextCount", store.getInt("nextCount", 0));
            state.put("detailChanges", store.getInt("detailChanges", 0));
            state.put("faultArmed", store.getBoolean("faultArmed", false));
            state.put("entries", new JSONArray(store.getString("entries", "[]")));
            try (FileOutputStream stream = openFileOutput("ledger.json", MODE_PRIVATE)) {
                stream.write(state.toString().getBytes(StandardCharsets.UTF_8));
                stream.getFD().sync();
            }
        } catch (Exception error) { throw new IllegalStateException(error); }
    }

    @Override public void onBackPressed() {
        if (page.endsWith("_result")) showDetail();
        else if ("left".equals(page) || "right".equals(page)) showEntry();
        else super.onBackPressed();
    }
}
