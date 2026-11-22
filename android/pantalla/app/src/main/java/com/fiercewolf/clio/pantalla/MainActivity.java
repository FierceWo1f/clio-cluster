package com.fiercewolf.clio.pantalla;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.net.DhcpInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.GridLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;

/**
 * Cascarón de la pantalla del estéreo.
 *
 * - Busca el hub que corre en el teléfono (Termux) en la puerta de enlace del hotspot,
 *   así no importa que la IP cambie.
 * - Muestra la interfaz web del hub a pantalla completa (sin barra de navegador).
 * - Se puede elegir como pantalla de inicio. Siempre hay forma de abrir las apps del estéreo:
 *   el panel "Apps" aparece mientras no hay teléfono, y se abre también manteniendo presionado Atrás
 *   o desde la web con ClioShell.showApps().
 */
public class MainActivity extends Activity {

    private static final int PORT = 8080;
    private static final String START_PATH = "/pantalla/";
    private static final long POLL_MS = 2500;
    private static final int FAILS_TO_DROP = 3;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private Handler bg;
    private HandlerThread bgThread;

    private SharedPreferences prefs;
    private WebView web;
    private LinearLayout overlay;
    private TextView status;
    private ScrollView appsPanel;
    private GridLayout appsGrid;

    private volatile String connectedHost = null; // host cargado en el WebView
    private int fails = 0;
    private boolean running = false;

    // ------------------------------------------------------------------ ciclo de vida

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("clio", MODE_PRIVATE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        buildUi();
        bgThread = new HandlerThread("hub-scan");
        bgThread.start();
        bg = new Handler(bgThread.getLooper());
    }

    @Override
    protected void onResume() {
        super.onResume();
        immersive();
        running = true;
        bg.removeCallbacksAndMessages(null);
        bg.post(scan);
        web.onResume();
    }

    @Override
    protected void onPause() {
        running = false;
        bg.removeCallbacksAndMessages(null);
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        bgThread.quit();
        web.destroy();
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) immersive();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        // Botón de inicio con la app ya abierta: cerrar el panel de apps
        super.onNewIntent(intent);
        hideApps();
    }

    // Atrás: cierra el panel / navega hacia atrás. Mantener presionado: abre el panel de apps.
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            event.startTracking();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyLongPress(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            showApps();
            return true;
        }
        return super.onKeyLongPress(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && event.isTracking() && !event.isCanceled()) {
            if (appsPanel.getVisibility() == View.VISIBLE) hideApps();
            else if (web.canGoBack()) web.goBack();
            return true; // es launcher: nunca se cierra con Atrás
        }
        return super.onKeyUp(keyCode, event);
    }

    // ------------------------------------------------------------------ interfaz

    private int dp(float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private Button button(String text, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextSize(18);
        b.setTextColor(Color.WHITE);
        GradientDrawable bgd = new GradientDrawable();
        bgd.setColor(0xFF1C2433);
        bgd.setCornerRadius(dp(10));
        bgd.setStroke(dp(1), 0xFF2E3A50);
        b.setBackground(bgd);
        b.setPadding(dp(18), dp(10), dp(18), dp(10));
        b.setOnClickListener(l);
        return b;
    }

    private void buildUi() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF07090D);

        // WebView con la interfaz del hub
        web = new WebView(this);
        web.setBackgroundColor(0xFF07090D);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        web.addJavascriptInterface(new Shell(), "ClioShell");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) ui.post(() -> dropConnection("La página no cargó"));
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onReceivedError(WebView view, int code, String desc, String url) {
                if (Build.VERSION.SDK_INT < 23) ui.post(() -> dropConnection("La página no cargó"));
            }
        });
        web.setVisibility(View.INVISIBLE);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));

        // Pantalla de "buscando teléfono"
        overlay = new LinearLayout(this);
        overlay.setOrientation(LinearLayout.VERTICAL);
        overlay.setGravity(Gravity.CENTER);
        overlay.setBackgroundColor(0xFF07090D);
        overlay.setPadding(dp(24), dp(24), dp(24), dp(24));

        TextView title = new TextView(this);
        title.setText("Clio");
        title.setTextColor(Color.WHITE);
        title.setTextSize(44);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        overlay.addView(title);

        status = new TextView(this);
        status.setTextColor(0xFF8B96A8);
        status.setTextSize(18);
        status.setGravity(Gravity.CENTER);
        status.setPadding(0, dp(12), 0, dp(24));
        overlay.addView(status);

        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2);
        lp.setMargins(dp(8), 0, dp(8), 0);
        row.addView(button("Apps", v -> showApps()), lp);
        row.addView(button("WiFi", v -> startSafe(new Intent(Settings.ACTION_WIFI_SETTINGS))), lp);
        row.addView(button("IP manual", v -> askHost()), lp);
        row.addView(button("Ajustes", v -> startSafe(new Intent(Settings.ACTION_SETTINGS))), lp);
        overlay.addView(row);
        root.addView(overlay, new FrameLayout.LayoutParams(-1, -1));

        // Panel de apps del estéreo (siempre disponible)
        appsPanel = new ScrollView(this);
        appsPanel.setBackgroundColor(0xF20B0E13);
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(20), dp(16), dp(20), dp(16));
        LinearLayout head = new LinearLayout(this);
        head.setGravity(Gravity.CENTER_VERTICAL);
        TextView ht = new TextView(this);
        ht.setText("Apps del estéreo");
        ht.setTextColor(Color.WHITE);
        ht.setTextSize(24);
        head.addView(ht, new LinearLayout.LayoutParams(0, -2, 1));
        head.addView(button("Cerrar", v -> hideApps()));
        panel.addView(head);
        appsGrid = new GridLayout(this);
        appsGrid.setColumnCount(6);
        appsGrid.setPadding(0, dp(12), 0, 0);
        panel.addView(appsGrid);
        appsPanel.addView(panel);
        appsPanel.setVisibility(View.GONE);
        root.addView(appsPanel, new FrameLayout.LayoutParams(-1, -1));

        setContentView(root);
        setStatus("Buscando el teléfono…");
    }

    private void immersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    private void setStatus(String extra) {
        String manual = prefs.getString("manualHost", "");
        status.setText(extra
                + "\n\n1. Activa el hotspot del teléfono y conecta el estéreo a esa red."
                + "\n2. En Termux: cd clio-cluster && python hub/hub.py"
                + (manual.isEmpty() ? "" : "\n\nIP manual: " + manual));
    }

    private void showApps() {
        appsGrid.removeAllViews();
        PackageManager pm = getPackageManager();
        for (final ResolveInfo ri : launchableApps()) {
            final String pkg = ri.activityInfo.packageName;
            TextView t = new TextView(this);
            t.setText(ri.loadLabel(pm));
            t.setTextColor(Color.WHITE);
            t.setTextSize(14);
            t.setGravity(Gravity.CENTER_HORIZONTAL);
            t.setMaxLines(2);
            Drawable icon = ri.loadIcon(pm);
            icon.setBounds(0, 0, dp(56), dp(56));
            t.setCompoundDrawables(null, icon, null, null);
            t.setCompoundDrawablePadding(dp(6));
            t.setPadding(dp(6), dp(10), dp(6), dp(10));
            t.setOnClickListener(v -> openApp(pkg));
            GridLayout.LayoutParams glp = new GridLayout.LayoutParams();
            glp.width = dp(140);
            appsGrid.addView(t, glp);
        }
        appsPanel.setVisibility(View.VISIBLE);
    }

    private void hideApps() {
        if (appsPanel != null) appsPanel.setVisibility(View.GONE);
    }

    private List<ResolveInfo> launchableApps() {
        Intent i = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> list = new ArrayList<>(getPackageManager().queryIntentActivities(i, 0));
        final PackageManager pm = getPackageManager();
        List<ResolveInfo> out = new ArrayList<>();
        for (ResolveInfo ri : list) {
            if (!ri.activityInfo.packageName.equals(getPackageName())) out.add(ri);
        }
        Collections.sort(out, (a, b) -> a.loadLabel(pm).toString().compareToIgnoreCase(b.loadLabel(pm).toString()));
        return out;
    }

    private void openApp(String pkg) {
        Intent i = getPackageManager().getLaunchIntentForPackage(pkg);
        if (i != null) {
            hideApps();
            startSafe(i);
        }
    }

    private void startSafe(Intent i) {
        try {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception ignored) {
        }
    }

    private void askHost() {
        final EditText in = new EditText(this);
        in.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        in.setHint("192.168.x.x  (vacío = automático)");
        in.setText(prefs.getString("manualHost", ""));
        new AlertDialog.Builder(this)
                .setTitle("IP del teléfono")
                .setView(in)
                .setPositiveButton("Guardar", (d, w) -> {
                    prefs.edit().putString("manualHost", in.getText().toString().trim()).apply();
                    setStatus("Buscando el teléfono…");
                    bg.removeCallbacksAndMessages(null);
                    bg.post(scan);
                })
                .setNegativeButton("Cancelar", null)
                .show();
    }

    // ------------------------------------------------------------------ búsqueda del hub

    private final Runnable scan = new Runnable() {
        @Override
        public void run() {
            if (!running) return;
            String cur = connectedHost;
            if (cur != null) {
                if (ping(cur)) {
                    fails = 0;
                } else if (++fails >= FAILS_TO_DROP) {
                    ui.post(() -> dropConnection("Se perdió la conexión con el teléfono"));
                }
            } else {
                for (String h : candidates()) {
                    if (ping(h)) {
                        final String found = h;
                        ui.post(() -> connect(found));
                        break;
                    }
                }
            }
            bg.postDelayed(this, POLL_MS);
        }
    };

    private List<String> candidates() {
        LinkedHashSet<String> c = new LinkedHashSet<>();
        String manual = prefs.getString("manualHost", "");
        if (!manual.isEmpty()) c.add(manual);
        String gw = gatewayIp();
        if (gw != null) c.add(gw); // con el hotspot del teléfono, el teléfono es la puerta de enlace
        String last = prefs.getString("lastHost", "");
        if (!last.isEmpty()) c.add(last);
        c.add("192.168.43.1"); // IP clásica del hotspot en Android
        return new ArrayList<>(c);
    }

    @SuppressWarnings("deprecation")
    private String gatewayIp() {
        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm == null) return null;
            DhcpInfo d = wm.getDhcpInfo();
            if (d == null || d.gateway == 0) return null;
            int g = d.gateway; // little-endian
            return String.format(Locale.US, "%d.%d.%d.%d", g & 0xff, (g >> 8) & 0xff, (g >> 16) & 0xff, (g >> 24) & 0xff);
        } catch (Exception e) {
            return null;
        }
    }

    private boolean ping(String host) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL("http://" + host + ":" + PORT + "/hub/status").openConnection();
            c.setConnectTimeout(1200);
            c.setReadTimeout(1200);
            c.setUseCaches(false);
            if (c.getResponseCode() != 200) return false;
            InputStream in = c.getInputStream();
            byte[] buf = new byte[512];
            int n = in.read(buf);
            in.close();
            return n > 0 && new String(buf, 0, n, "UTF-8").contains("clients");
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private void connect(String host) {
        if (connectedHost != null) return;
        connectedHost = host;
        fails = 0;
        prefs.edit().putString("lastHost", host).apply();
        hideApps();
        web.loadUrl("http://" + host + ":" + PORT + START_PATH);
        web.setVisibility(View.VISIBLE);
        overlay.setVisibility(View.GONE);
    }

    private void dropConnection(String why) {
        if (connectedHost == null) return;
        connectedHost = null;
        fails = 0;
        web.stopLoading();
        web.loadUrl("about:blank");
        web.setVisibility(View.INVISIBLE);
        overlay.setVisibility(View.VISIBLE);
        setStatus(why + ". Buscando el teléfono…");
    }

    // ------------------------------------------------------------------ puente para la web

    /** Disponible en JavaScript como window.ClioShell */
    private class Shell {
        @JavascriptInterface
        public int version() {
            return 1;
        }

        @JavascriptInterface
        public String host() {
            return connectedHost == null ? "" : connectedHost;
        }

        @JavascriptInterface
        public String apps() {
            JSONArray arr = new JSONArray();
            PackageManager pm = getPackageManager();
            try {
                for (ResolveInfo ri : launchableApps()) {
                    JSONObject o = new JSONObject();
                    o.put("label", ri.loadLabel(pm).toString());
                    o.put("pkg", ri.activityInfo.packageName);
                    arr.put(o);
                }
            } catch (Exception ignored) {
            }
            return arr.toString();
        }

        @JavascriptInterface
        public void open(final String pkg) {
            ui.post(() -> openApp(pkg));
        }

        @JavascriptInterface
        public void showApps() {
            ui.post(MainActivity.this::showApps);
        }

        @JavascriptInterface
        public void settings() {
            ui.post(() -> startSafe(new Intent(Settings.ACTION_SETTINGS)));
        }

        @JavascriptInterface
        public void wifi() {
            ui.post(() -> startSafe(new Intent(Settings.ACTION_WIFI_SETTINGS)));
        }
    }
}
