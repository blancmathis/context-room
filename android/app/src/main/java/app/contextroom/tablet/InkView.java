package app.contextroom.tablet;

import android.content.Context;
import android.graphics.*;
import android.view.*;
import java.util.*;
import org.json.*;

/** Native retained canvas: the in-progress stroke never belongs to a server snapshot. */
final class InkView extends View {
  interface Listener {
    void change(JSONArray operations);

    default void changeGesture(JSONArray operations, String gestureId) { change(operations); }

    void viewport();

    void text(float x, float y);

    void selection(int count);

    void draft(JSONArray points);

    default void interaction() {}

    default void remoteApplied(InkView source) {}
  }

  final LinkedHashMap<String, JSONObject> objects = new LinkedHashMap<>();
  final LinkedHashMap<String, JSONObject> agentInk = new LinkedHashMap<>();
  PointF agentTip;
  final HashSet<String> selected = new HashSet<>();
  final HashMap<String, Long> revisions = new HashMap<>();
  final ArrayDeque<JSONArray> undoStack = new ArrayDeque<>(), redoStack = new ArrayDeque<>();
  boolean recordingHistory = true;
  final HashMap<String, Path> paths = new HashMap<>();
  final HashMap<String, RectF> inkBounds = new HashMap<>();
  final HashMap<String, Bitmap> images = new HashMap<>();
  final HashSet<String> imageErrors = new HashSet<>();
  final InkSceneCache sceneCache = new InkSceneCache(this);
  final InkDragRaster dragRaster = new InkDragRaster(this);
  boolean snapshotRecording;
  final Paint paint = new Paint(3);
  final Path live = new Path();
  final Listener listener;
  BooxInk boox;
  boolean booxSuspended = false;
  String tool = "ink";
  float scale = 1, offsetX = 32, offsetY = 32, downX, downY, lastX, lastY, startX, startY;
  boolean drawing = false, panning = false, transform = false, resize = false;
  JSONArray points = new JSONArray();
  JSONArray inkGestureHistory;
  String nativeInkId, nativeGestureId;
  int nativeInkCount;
  long nativeInkRevision;
  final ArrayList<String> rawSegmentIds = new ArrayList<>();
  static final int INK_SEGMENT_POINTS = 4096;
  final ArrayList<PointF> lasso = new ArrayList<>();
  final HashMap<String, JSONObject> before = new HashMap<>();
  final LinkedHashMap<String, JSONObject> deferredRemote = new LinkedHashMap<>();
  boolean transformMoved;
  float transformDX,transformDY,transformScale=1;
  boolean proportionalResize,ignoreSelectionPointer;
  final RectF transformBox=new RectF();
  final ScaleGestureDetector zoom;

  InkView(Context c, Listener l) {
    super(c);
    listener = l;
    scale = c.getResources().getDisplayMetrics().density;
    setBackgroundColor(Color.WHITE);
    setFocusable(true);
    setContentDescription(
        "Tableau de dessin. Le stylet dessine ; deux doigts déplacent et agrandissent.");
    zoom =
        new ScaleGestureDetector(
            c,
            new ScaleGestureDetector.SimpleOnScaleGestureListener() {
              @Override
              public boolean onScale(ScaleGestureDetector d) {
                float old = scale;
                scale = Math.max(.15f, Math.min(8, scale * d.getScaleFactor()));
                offsetX = d.getFocusX() - (d.getFocusX() - offsetX) * scale / old;
                offsetY = d.getFocusY() - (d.getFocusY() - offsetY) * scale / old;
                invalidate();
                return true;
              }
            });
  }

  void toggleBoox() {
    if (!BooxInk.supportedDevice()) {
      ToastMessage();
      return;
    }
    boolean value = !getContext().getSharedPreferences("ink", 0).getBoolean("boox", false);
    getContext().getSharedPreferences("ink", 0).edit().putBoolean("boox", value).apply();
    if (boox == null) boox = new BooxInk(this);
    boox.suspended = booxSuspended;
    boox.enable(value);
  }

  void ToastMessage() {
    android.widget.Toast.makeText(
            getContext(),
            "Ce mode nécessite une tablette BOOX compatible.",
            android.widget.Toast.LENGTH_LONG)
        .show();
  }

  void suspendBoox(boolean value) {
    booxSuspended = value;
    if (boox != null) {
      boox.suspended = value;
      boox.refresh();
    }
  }

  long visualRevision;
  boolean renderingModeDirty = true;
  @Override public void invalidate() {
    visualRevision++;
    if (renderingModeDirty && objects != null) {
      renderingModeDirty = false;
      int samples = 0; boolean dense = false;
      for (JSONObject object : objects.values()) {
        if (!object.optString("type").equals("ink")) continue;
        JSONArray stroke = object.optJSONArray("points");
        int count = stroke == null ? 0 : stroke.length(); samples += count;
        if (count >= 1024 || samples >= 8192) {dense = true; break;}
      }
      // Software rasterization avoids expensive GPU tessellation of overlapping
      // pressure contours. Only this canvas switches; the surrounding UI stays accelerated.
      int layer = dense ? View.LAYER_TYPE_SOFTWARE : View.LAYER_TYPE_NONE;
      if (getLayerType() != layer) setLayerType(layer, null);
    }
    super.invalidate();
  }

  @Override
  protected void onAttachedToWindow() {
    super.onAttachedToWindow();
    sceneCache.activate();
    dragRaster.activate();
    post(
        () -> {
          if (BooxInk.supportedDevice()
              && getContext().getSharedPreferences("ink", 0).getBoolean("boox", false)) {
            boox = new BooxInk(this);
            boox.suspended = booxSuspended;
            boox.enable(true);
          }
        });
  }

  @Override
  protected void onDetachedFromWindow() {
    if (boox != null) boox.close();
    sceneCache.close();
    dragRaster.close();
    super.onDetachedFromWindow();
  }

  @Override
  public void onWindowFocusChanged(boolean focus) {
    super.onWindowFocusChanged(focus);
    if (boox != null) boox.refresh();
  }

  @Override
  protected void onSizeChanged(int w, int h, int oldW, int oldH) {
    super.onSizeChanged(w, h, oldW, oldH);
    if (boox != null) boox.refresh();
  }

  static JSONObject copy(JSONObject o) {
    try {
      JSONObject result=new JSONObject();Iterator<String> keys=o.keys();
      while(keys.hasNext()){String key=keys.next();result.put(key,copyValue(o.get(key)));}
      return result;
    } catch (JSONException e) {
      throw new IllegalArgumentException(e);
    }
  }

  private static Object copyValue(Object value) throws JSONException {
    if(value instanceof JSONObject)return copy((JSONObject)value);
    if(value instanceof JSONArray){JSONArray source=(JSONArray)value,result=new JSONArray();for(int n=0;n<source.length();n++)result.put(copyValue(source.get(n)));return result;}
    return value;
  }

  static JSONObject json(Object... values) {
    JSONObject o = new JSONObject();
    try {
      for (int i = 0; i < values.length; i += 2) o.put((String) values[i], values[i + 1]);
    } catch (Exception e) {
      throw new IllegalArgumentException(e);
    }
    return o;
  }

  void setTool(String value) {
    finishReachedInk();
    finishTransform(false);
    tool = value;
    if (boox != null) boox.refresh();
    selected.clear();
    listener.selection(0);
    invalidate();
  }

  JSONArray merge(JSONArray values, Set<String> pending, boolean full) {
    boolean changed = false;
    JSONArray changes=new JSONArray();
    if (full) {
      HashSet<String> ids = new HashSet<>();
      for (int i = 0; i < values.length(); i++) ids.add(values.optJSONObject(i).optString("id"));
      for (String id : new ArrayList<>(objects.keySet()))
        if (!ids.contains(id) && !pending.contains(id)) {
          changes.put(json("id",id,"value",JSONObject.NULL));
          if(before.containsKey(id)){
            deferredRemote.put(id,json("id",id,"deleted",true,"revision",revisions.getOrDefault(id,0L)));
            continue;
          }
          objects.remove(id);
          invalidateGeometry(id);
          changed = true;
        }
    }
    for (int i = 0; i < values.length(); i++) {
      JSONObject o = values.optJSONObject(i);
      String id = o.optString("id");
      revisions.put(id, o.optLong("revision"));
      if (pending.contains(id)) continue;
      if (before.containsKey(id)) {
        // Advance the durable canonical state together with the board cursor,
        // while leaving the object under the user's pen undisturbed.
        JSONObject latest=copy(o);deferredRemote.put(id,latest);
        changes.put(json("id",id,"value",o.optBoolean("deleted")?JSONObject.NULL:latest));
        continue;
      }
      JSONObject old = objects.get(id);
      if (sameJson(old,o)) continue;
      if (o.optBoolean("deleted")) objects.remove(id);
      else objects.put(id, copy(o));
      changes.put(json("id",id,"value",objects.containsKey(id)?objects.get(id):JSONObject.NULL));
      invalidateGeometry(id);
      changed = true;
    }
    if (selected.retainAll(objects.keySet())) {
      listener.selection(selected.size());
      changed = true;
    }
    if (changed) invalidate();
    return changes;
  }

  JSONArray snapshot() {
    JSONArray a = new JSONArray();
    for (JSONObject o : objects.values()) a.put(o);
    return a;
  }

  static boolean sameJson(Object a,Object b){
    if(a==b)return true;if(a==null||b==null)return false;
    if(a instanceof JSONObject&&b instanceof JSONObject){
      JSONObject left=(JSONObject)a,right=(JSONObject)b;if(left.length()!=right.length())return false;
      Iterator<String> keys=left.keys();while(keys.hasNext()){String key=keys.next();if(!right.has(key)||!sameJson(left.opt(key),right.opt(key)))return false;}return true;
    }
    if(a instanceof JSONArray&&b instanceof JSONArray){
      JSONArray left=(JSONArray)a,right=(JSONArray)b;if(left.length()!=right.length())return false;
      for(int n=0;n<left.length();n++)if(!sameJson(left.opt(n),right.opt(n)))return false;return true;
    }
    if(a instanceof Number&&b instanceof Number){
      if((a instanceof Integer||a instanceof Long)&&(b instanceof Integer||b instanceof Long))return ((Number)a).longValue()==((Number)b).longValue();
      return Double.compare(((Number)a).doubleValue(),((Number)b).doubleValue())==0;
    }
    return a.equals(b);
  }

  void invalidateGeometry(String id) {
    sceneCache.changed(id);
    renderingModeDirty = true;
    paths.remove(id);
    inkBounds.remove(id);
  }

  RectF bounds(JSONObject o) {
    return bounds(o, o.optString("type").equals("connector") ? new HashSet<>() : Collections.emptySet());
  }

  RectF bounds(JSONObject o, Set<String> visiting) {
    if (o.optString("type").equals("connector") && visiting.add(o.optString("id"))) {
      float[] ends = lineEnds(o, visiting);
      visiting.remove(o.optString("id"));
      RectF box = new RectF(Math.min(ends[0], ends[2]), Math.min(ends[1], ends[3]),
          Math.max(ends[0], ends[2]), Math.max(ends[1], ends[3]));
      if(o.optString("route").equals("outside-left"))box.left-=(float)o.optDouble("routeOffset",48);
      box.inset(-12, -12);
      return box;
    }
    if (o.optString("type").equals("ink")) {
      RectF result=rawInkBounds(o);
      if(previewInk(o)){
        if(resize){result.set(transformBox.left+(result.left-transformBox.left)*transformScale,transformBox.top+(result.top-transformBox.top)*transformScale,
            transformBox.left+(result.right-transformBox.left)*transformScale,transformBox.top+(result.bottom-transformBox.top)*transformScale);}
        else result.offset(transformDX,transformDY);
      }
      return result;
    }
    float x = (float) o.optDouble("x"),
        y = (float) o.optDouble("y"),
        w = (float) o.optDouble("w", 160),
        h = (float) o.optDouble("h", 60);
    return new RectF(
        Math.min(x, x + w), Math.min(y, y + h), Math.max(x, x + w), Math.max(y, y + h));
  }

  boolean previewInk(JSONObject object){
    return transform&&(!resize||proportionalResize)&&transformMoved&&before.get(object.optString("id"))==object&&object.optString("type").equals("ink");
  }

  RectF rawInkBounds(JSONObject o) {
      String id=o.optString("id");boolean retained=objects.get(id)==o;
      RectF cached=retained?inkBounds.get(id):null;
      if(cached!=null)return new RectF(cached);
      JSONArray p = o.optJSONArray("points");
      RectF r = new RectF();float radius=3;
      if (p != null)
        for (int i = 0; i < p.length(); i++) {
          JSONArray q = p.optJSONArray(i);
          float x = (float) q.optDouble(0), y = (float) q.optDouble(1);
          radius=Math.max(radius,(float)o.optDouble("width",2)*Math.max(.15f,(float)q.optDouble(2,1))/2);
          if (i == 0) r.set(x, y, x + .1f, y + .1f);
          else r.union(x, y);
        }
      r.inset(-radius, -radius);
      if(retained)inkBounds.put(id,new RectF(r));
      return r;
  }

  float[] lineEnds(JSONObject o, Set<String> visiting) {
    float x=(float)o.optDouble("x"), y=(float)o.optDouble("y");
    if (o.optString("type").equals("connector") && objects.containsKey(o.optString("from"))
        && objects.containsKey(o.optString("to"))) {
      RectF a=bounds(objects.get(o.optString("from")), visiting), b=bounds(objects.get(o.optString("to")), visiting);
      float[] from=connectorPort(a,o.optString("fromSide")),to=connectorPort(b,o.optString("toSide"));
      return new float[]{from[0],from[1],to[0],to[1]};
    }
    return new float[]{x,y,x+(float)o.optDouble("w"),y+(float)o.optDouble("h")};
  }

  static float[] connectorPort(RectF box,String side) {
    switch(side) {
      case "left":return new float[]{box.left,box.centerY()};
      case "right":return new float[]{box.right,box.centerY()};
      case "top":return new float[]{box.centerX(),box.top};
      case "bottom":return new float[]{box.centerX(),box.bottom};
      default:return new float[]{box.centerX(),box.centerY()};
    }
  }

  float[] lineRoute(JSONObject o,Set<String> visiting) {
    float[] ends=lineEnds(o,visiting);
    if(o.optString("type").equals("connector")&&o.optString("route").equals("outside-left")){
      float lane=Math.min(ends[0],ends[2])-(float)o.optDouble("routeOffset",48);
      return new float[]{ends[0],ends[1],lane,ends[1],lane,ends[3],ends[2],ends[3]};
    }
    return ends;
  }

  Path path(JSONObject o) {
    String id = o.optString("id");
    if (paths.containsKey(id)) return paths.get(id);
    Path p = new Path();
    JSONArray a = o.optJSONArray("points");
    int previous = -1;
    if (a != null)
      for (int i = 0; i < a.length(); i++) {
        JSONArray q = a.optJSONArray(i);
        float x = (float) q.optDouble(0), y = (float) q.optDouble(1);
        float radius =
            (float) o.optDouble("width", 2) * Math.max(.15f, (float) q.optDouble(2, 1)) / 2;
        // Omit only geometrically redundant samples from the rendered path.
        // The original points stay intact for synchronization, undo and export.
        // Equal pressure, exact collinearity and forward travel preserve the
        // same union of circles and quads, including rounded ends.
        if (previous >= 0 && i+1 < a.length()) {
          JSONArray prev=a.optJSONArray(previous), next=a.optJSONArray(i+1);
          float px=(float)prev.optDouble(0), py=(float)prev.optDouble(1);
          float nx=(float)next.optDouble(0), ny=(float)next.optDouble(1);
          float pressure=Math.max(.15f,(float)q.optDouble(2,1));
          if(pressure==Math.max(.15f,(float)prev.optDouble(2,1)) && pressure==Math.max(.15f,(float)next.optDouble(2,1))
              && (double)(x-px)*(ny-y)==(double)(y-py)*(nx-x)
              && (double)(x-px)*(nx-x)+(double)(y-py)*(ny-y)>=0)continue;
        }
        p.addCircle(x, y, radius, Path.Direction.CW);
        if (previous >= 0) {
          JSONArray prev = a.optJSONArray(previous);
          float px = (float) prev.optDouble(0), py = (float) prev.optDouble(1);
          float length = (float) Math.hypot(x - px, y - py);
          if (length > 0) {
            float nx = -(y - py) / length,
                ny = (x - px) / length,
                pr =
                    (float) o.optDouble("width", 2)
                        * Math.max(.15f, (float) prev.optDouble(2, 1))
                        / 2;
            // Match the clockwise circles so overlapping joins add, rather than cancel.
            p.moveTo(px - nx * pr, py - ny * pr);
            p.lineTo(x - nx * radius, y - ny * radius);
            p.lineTo(x + nx * radius, y + ny * radius);
            p.lineTo(px + nx * pr, py + ny * pr);
            p.close();
          }
        }
        previous = i;
      }
    paths.put(id, p);
    return p;
  }

  void drawSnapshot(Canvas canvas){
    boolean previous=snapshotRecording;snapshotRecording=true;
    try{draw(canvas);}finally{snapshotRecording=previous;}
  }

  @Override
  protected void onDraw(Canvas c) {
    super.onDraw(c);
    boolean dragging=transform&&transformMoved;
    boolean cached=!dragging&&sceneCache.draw(c);
    c.save();
    c.translate(offsetX, offsetY);
    c.scale(scale, scale);
    if(!cached)render(c, true);
    for(JSONObject stroke:agentInk.values()){
      // Live prefixes share a stable object id but change each frame. Keep the
      // canonical path cache separate from the temporary remote overlay.
      String id=stroke.optString("id");Path saved=paths.remove(id);
      drawObject(c,stroke,false);paths.remove(id);if(saved!=null)paths.put(id,saved);
    }
    if(agentTip!=null){
      paint.setStyle(Paint.Style.FILL);paint.setColor(Color.WHITE);c.drawCircle(agentTip.x,agentTip.y,6/scale,paint);
      paint.setStyle(Paint.Style.STROKE);paint.setColor(Color.BLACK);paint.setStrokeWidth(2/scale);c.drawCircle(agentTip.x,agentTip.y,6/scale,paint);
      paint.setStyle(Paint.Style.FILL);paint.setTextSize(12/scale);c.drawText("Codex",agentTip.x+10/scale,agentTip.y-10/scale,paint);
    }
    if (drawing && tool.equals("ink")) {
      paint.setColor(Color.BLACK);
      paint.setStyle(Paint.Style.STROKE);
      paint.setStrokeWidth(2);
      paint.setStrokeCap(Paint.Cap.ROUND);
      c.drawPath(live, paint);
    }
    if (drawing && Arrays.asList("rect", "ellipse", "arrow", "line").contains(tool)) {
      drawObject(
          c,
          json(
              "type",
              tool,
              "x",
              Math.min(startX, lastX),
              "y",
              Math.min(startY, lastY),
              "w",
              Math.abs(lastX - startX),
              "h",
              Math.abs(lastY - startY)),
          false);
    }
    if (lasso.size() > 1) {
      Path p = new Path();
      p.moveTo(lasso.get(0).x, lasso.get(0).y);
      for (PointF a : lasso) p.lineTo(a.x, a.y);
      paint.setStrokeWidth(1 / scale);
      paint.setStyle(Paint.Style.STROKE);
      paint.setColor(Color.DKGRAY);
      c.drawPath(p, paint);
    }
    drawSelection(c);
    c.restore();
    if(!snapshotRecording)dragRaster.prepare();
  }

  void render(Canvas c, boolean selections) {
    List<JSONObject> sorted = new ArrayList<>(objects.values());
    sorted.sort(Comparator.comparingDouble(o -> o.optDouble("z", 0)));
    RectF visible =
        new RectF(
            -offsetX / scale,
            -offsetY / scale,
            (getWidth() - offsetX) / scale,
            (getHeight() - offsetY) / scale);
    for (JSONObject o : sorted) {
      if (selections
          && !RectF.intersects(visible, bounds(o))
          && !o.optString("type").equals("connector")) continue;
      drawObject(c, o, selections);
    }
  }

  void drawObject(Canvas c, JSONObject o, boolean selection) {
    int strokeColor = cssColor(o.optString("color", "#222222"));
    paint.setColor(strokeColor);
    paint.setStyle(Paint.Style.STROKE);
    paint.setStrokeWidth((float) o.optDouble("width", 2));
    paint.setStrokeCap(Paint.Cap.ROUND);
    paint.setStrokeJoin(Paint.Join.ROUND);
    RectF b = bounds(o);
    String type = o.optString("type");
    c.save();
    double angle = o.optDouble("rotation", 0);
    if (Double.isFinite(angle) && angle != 0) {
      JSONObject canonical = o.optJSONObject("canonical");
      float cx = (float)o.optDouble("x") + (float)(canonical == null ? o.optDouble("w",140) : canonical.optDouble("width",140))/2;
      float cy = (float)o.optDouble("y") + (type.equals("text") ? (float)o.optDouble("fontSize",18) : 0) + (float)(canonical == null ? o.optDouble("h",80) : canonical.optDouble("height",80))/2;
      c.rotate((float)angle,cx,cy);
    }
    if ((type.equals("rect") || type.equals("ellipse")) && !Arrays.asList("", "none", "transparent").contains(o.optString("fill"))) {
      paint.setStyle(Paint.Style.FILL); paint.setColor(cssColor(o.optString("fill")));
      if (type.equals("rect")) c.drawRect(b,paint); else c.drawOval(b,paint);
      paint.setStyle(Paint.Style.STROKE); paint.setColor(strokeColor);
    }
    switch (type) {
      case "ink":
        paint.setStyle(Paint.Style.FILL);
        c.save();
        if(previewInk(o)){
          if(resize){c.translate(transformBox.left,transformBox.top);c.scale(transformScale,transformScale);c.translate(-transformBox.left,-transformBox.top);}
          else c.translate(transformDX,transformDY);
        }
        boolean preview=selection&&transform&&transformMoved&&!snapshotRecording&&!c.isHardwareAccelerated();
        if(!preview||!dragRaster.draw(c,o))c.drawPath(path(o), paint);
        c.restore();
        break;
      case "rect":
        c.drawRect(b, paint);
        break;
      case "ellipse":
        c.drawOval(b, paint);
        break;
      case "arrow":
      case "connector":
      case "line":
        float[] ends = lineRoute(o, new HashSet<>(Collections.singleton(o.optString("id"))));
        int last=ends.length-2;
        float x=ends[last-2], y=ends[last-1], ex=ends[last], ey=ends[last+1];
        for(int n=2;n<ends.length;n+=2)c.drawLine(ends[n-2],ends[n-1],ends[n],ends[n+1],paint);
        if (type.equals("line")) break;
        double arrowAngle = Math.atan2(ey - y, ex - x);
        c.drawLine(
            ex,
            ey,
            ex - 12 * (float) Math.cos(arrowAngle - .5),
            ey - 12 * (float) Math.sin(arrowAngle - .5),
            paint);
        c.drawLine(
            ex,
            ey,
            ex - 12 * (float) Math.cos(arrowAngle + .5),
            ey - 12 * (float) Math.sin(arrowAngle + .5),
            paint);
        break;
      case "text":
        paint.setStyle(Paint.Style.FILL);
        paint.setTextSize((float) o.optDouble("fontSize", 22));
        float ty = b.top + paint.getTextSize();
        for (String line : o.optString("text").split("\n")) {
          c.drawText(line, b.left, ty, paint);
          ty += paint.getTextSize() * 1.3f;
        }
        break;
      case "image":
        Bitmap image = images.get(o.optString("assetId"));
        if (image != null) c.drawBitmap(image, null, b, paint);
        else {
          c.drawRect(b, paint);
          paint.setStyle(Paint.Style.FILL);
          paint.setTextSize(16);
          c.drawText(imageErrors.contains(o.optString("assetId"))?"Image indisponible":"Chargement de l’image…", b.left + 8, b.top + 24, paint);
        }
        break;
    }
    c.restore();
  }

  static int cssColor(String value) {
    if (value.equals("none") || value.equals("transparent")) return Color.TRANSPARENT;
    if (value.startsWith("#") && (value.length() == 4 || value.length() == 5)) {
      StringBuilder expanded = new StringBuilder("#"); for (int n = 1; n < value.length(); n++) expanded.append(value.charAt(n)).append(value.charAt(n)); value = expanded.toString();
    }
    if (value.startsWith("#") && value.length() == 9) value = "#" + value.substring(7,9) + value.substring(1,7);
    try { return Color.parseColor(value); } catch (IllegalArgumentException error) { return Color.BLACK; }
  }

  RectF selectedBounds(){
    RectF box=new RectF();boolean first=true;
    for(String id:selected){JSONObject object=objects.get(id);if(object==null)continue;RectF bounds=bounds(object);if(first){box.set(bounds);first=false;}else box.union(bounds);}
    return box;
  }
  boolean selectionCanResize(){
    if(selected.isEmpty())return false;
    // A locked member must not silently move or resize as part of a group.
    for(String id:selected){JSONObject object=objects.get(id);if(object==null||object.optBoolean("locked"))return false;}
    return true;
  }
  boolean nearSelectionHandle(float x,float y,boolean stylus){
    if(!selectionCanResize())return false;RectF box=selectedBounds();
    float reach=(stylus?18:24)*getResources().getDisplayMetrics().density/scale;
    return Math.abs(x-box.right-6/scale)<=reach&&Math.abs(y-box.bottom-6/scale)<=reach;
  }
  void drawSelection(Canvas canvas){
    if(selected.isEmpty())return;
    RectF frame=selectedBounds();frame.inset(-6/scale,-6/scale);
    paint.setColor(Color.BLACK);paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(1.5f/scale);
    paint.setPathEffect(new DashPathEffect(new float[]{6/scale,5/scale},0));canvas.drawRect(frame,paint);paint.setPathEffect(null);
    if(!selectionCanResize())return;
    float half=7*getResources().getDisplayMetrics().density/scale;
    RectF handle=new RectF(frame.right-half,frame.bottom-half,frame.right+half,frame.bottom+half);
    paint.setStyle(Paint.Style.FILL);paint.setColor(Color.WHITE);canvas.drawRect(handle,paint);
    paint.setColor(Color.BLACK);paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(2/scale);canvas.drawRect(handle,paint);
  }

  static boolean sameGeometry(JSONObject a,JSONObject b) {
    if(a==b)return true;if(a==null||b==null)return false;
    Set<String> keys=new HashSet<>();for(JSONObject value:new JSONObject[]{a,b}){Iterator<String> names=value.keys();while(names.hasNext())keys.add(names.next());}
    keys.remove("revision");keys.remove("actor");
    for(String key:keys)if(!a.has(key)||!b.has(key)||!sameJson(a.opt(key),b.opt(key)))return false;
    return true;
  }

  boolean cancelSelectionGesture(){
    if(!transform)return false;
    finishTransform(false);ignoreSelectionPointer=true;return true;
  }

  boolean undoLocal(boolean redo) {
    if(cancelSelectionGesture())return true;
    ArrayDeque<JSONArray> from = redo ? redoStack : undoStack, to = redo ? undoStack : redoStack;
    if (from.isEmpty()) return false;
    JSONArray history = from.peek(), ops = new JSONArray();
    for (int i = 0; i < history.length(); i++) {
      JSONObject h = history.optJSONObject(i);
      String id = h.optString("id");
      JSONObject expected = h.optJSONObject(redo ? "before" : "after");
      if (!sameGeometry(expected,objects.get(id)))
        throw new IllegalStateException(
            "Cet objet a changé depuis cette action. Utilise l’historique pour relire les"
                + " changements.");
      JSONObject desired = h.optJSONObject(redo ? "after" : "before");
      JSONObject current = objects.get(id);
      long rev = current == null ? revisions.getOrDefault(id, 0L) : current.optLong("revision");
      if (desired != null) {
        desired = copy(desired);
        try {
          desired.put("revision", rev);
        } catch (Exception ignored) {
        }
      }
      ops.put(
          json(
              "id",
              id,
              "expectedRevision",
              rev,
              "value",
              desired == null ? JSONObject.NULL : desired));
    }
    from.pop();
    to.push(history);
    recordingHistory = false;
    try {
      commit(ops);
    } finally {
      recordingHistory = true;
    }
    return true;
  }

  void fitContent() {
    listener.interaction();
    RectF b = contentBounds();
    scale =
        Math.max(.15f, Math.min(2f, Math.min(getWidth() / b.width(), getHeight() / b.height())));
    offsetX = (getWidth() - b.width() * scale) / 2 - b.left * scale;
    offsetY = (getHeight() - b.height() * scale) / 2 - b.top * scale;
    invalidate();
    listener.viewport();
  }

  boolean gestureActive(){return drawing||panning||transform||zoom.isInProgress()||(boox!=null&&boox.rawInputActive);}

  JSONArray viewportBounds(){
    try{return new JSONArray().put(-offsetX/scale).put(-offsetY/scale).put(getWidth()/scale).put(getHeight()/scale);}
    catch(JSONException impossible){throw new IllegalStateException(impossible);}
  }

  boolean frameAgent(JSONArray bounds){
    if(gestureActive()||getWidth()<1||getHeight()<1||bounds==null||bounds.length()!=4)return false;
    double[] b=new double[4];
    for(int n=0;n<4;n++){
      Object value=bounds.opt(n);if(!(value instanceof Number))return false;b[n]=((Number)value).doubleValue();
      if(!Double.isFinite(b[n])||(n<2?Math.abs(b[n])>1e7:b[n]<1||b[n]>1e6))return false;
    }
    float padding=Math.min(32*getResources().getDisplayMetrics().density,Math.min(getWidth(),getHeight())/5f);
    scale=(float)Math.max(.15,Math.min(8,Math.min((getWidth()-padding*2)/b[2],(getHeight()-padding*2)/b[3])));
    offsetX=(float)(getWidth()/2.0-(b[0]+b[2]/2)*scale);
    offsetY=(float)(getHeight()/2.0-(b[1]+b[3]/2)*scale);
    invalidate();if(boox!=null)boox.refresh();return true;
  }

  RectF contentBounds() {
    RectF result = new RectF();
    boolean first = true;
    for (JSONObject o : objects.values()) {
      RectF b = bounds(o);
      if (first) {
        result.set(b);
        first = false;
      } else result.union(b);
    }
    if (first) result.set(0, 0, 800, 1000);
    result.inset(-32, -32);
    return result;
  }

  String hit(float x, float y) {
    List<String> ids = new ArrayList<>(objects.keySet());
    ids.sort(Comparator.comparingDouble(id->objects.get(id).optDouble("z",0)));
    Collections.reverse(ids);
    for (String id : ids) {
      JSONObject o = objects.get(id);
      RectF b = bounds(o);
      b.inset(-10 / scale, -10 / scale);
      if (b.contains(x, y)) {
        if (o.optString("type").equals("connector") || o.optString("type").equals("arrow")) {
          float[] ends=lineRoute(o,new HashSet<>(Collections.singleton(id)));
          for(int n=2;n<ends.length;n+=2){
            float ax=ends[n-2],ay=ends[n-1],dx=ends[n]-ax,dy=ends[n+1]-ay,length=dx*dx+dy*dy;
            float t=length==0 ? 0 : Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/length));
            if(Math.hypot(x-ax-t*dx,y-ay-t*dy)<=Math.max(10/scale,o.optDouble("width",2)))return id;
          }
        } else if (o.optString("type").equals("ink")) {
          JSONArray points = o.optJSONArray("points");
          float tolerance = Math.max(8 / scale, (float) o.optDouble("width", 2));
          for (int k = 0; points != null && k < points.length(); k++) {
            JSONArray a = points.optJSONArray(Math.max(0, k - 1)), z = points.optJSONArray(k);
            float ax = (float) a.optDouble(0),
                ay = (float) a.optDouble(1),
                zx = (float) z.optDouble(0),
                zy = (float) z.optDouble(1);
            float length = (zx - ax) * (zx - ax) + (zy - ay) * (zy - ay);
            float t =
                length == 0
                    ? 0
                    : Math.max(
                        0, Math.min(1, ((x - ax) * (zx - ax) + (y - ay) * (zy - ay)) / length));
            if (Math.hypot(x - ax - t * (zx - ax), y - ay - t * (zy - ay)) <= tolerance) return id;
          }
        } else return id;
      }
    }
    return null;
  }

  void commit(JSONArray ops) {
    commitGesture(ops, null);
  }

  void commitGesture(JSONArray ops, String gestureId) {
    if (recordingHistory) {
      JSONArray history = new JSONArray();
      for (int i = 0; i < ops.length(); i++) {
        JSONObject op = ops.optJSONObject(i);
        String id = op.optString("id");
        JSONObject previous = before.containsKey(id) ? before.get(id) : objects.get(id);
        history.put(
            json(
                "id",
                id,
                "before",
                previous == null ? JSONObject.NULL : copy(previous),
                "after",
                op.isNull("value") ? JSONObject.NULL : copy(op.optJSONObject("value"))));
      }
      undoStack.push(history);
      while (undoStack.size() > 100) undoStack.removeLast();
      redoStack.clear();
    }
    for (int i = 0; i < ops.length(); i++) {
      JSONObject op = ops.optJSONObject(i);
      String id = op.optString("id");
      JSONObject value = op.optJSONObject("value");
      if (value != null) value = copy(value);
      if (value != null) try { value.put("revision", op.optLong("expectedRevision") + 1); } catch (JSONException error) { throw new IllegalArgumentException(error); }
      boolean added=recordingHistory&&!objects.containsKey(id)&&value!=null;
      if (value == null) objects.remove(id);
      else objects.put(id, value);
      invalidateGeometry(id);
      sceneCache.localChange(id,added);
    }
    JSONArray captured;
    try { captured = new JSONArray(ops.toString()); } catch (JSONException error) { throw new IllegalArgumentException(error); }
    if (gestureId == null) listener.change(captured); else listener.changeGesture(captured, gestureId);
    invalidate();
  }

  void add(JSONObject value) {
    String id = UUID.randomUUID().toString();
    try {
      value.put("id", id).put("revision", 0);
    } catch (Exception ignored) {
    }
    commit(new JSONArray().put(json("id", id, "expectedRevision", 0, "value", value)));
  }

  void selectedAction(String action) {
    cancelSelectionGesture();
    JSONArray ops = new JSONArray();
    if (action.equals("connect") && selected.size() == 2) {
      Iterator<String> it = selected.iterator();
      String a = it.next(), b = it.next();
      add(json("type", "connector", "from", a, "to", b, "x", 0, "y", 0, "w", 100, "h", 100));
      return;
    }
    Map<String,String> duplicates=new HashMap<>();
    if(action.equals("duplicate"))for(String id:selected)if(objects.containsKey(id))duplicates.put(id,UUID.randomUUID().toString());
    for (String id : new ArrayList<>(selected)) {
      JSONObject o = objects.get(id);
      if (o == null) continue;
      JSONObject n = copy(o);
      if (action.equals("delete")) {
        if (o.optBoolean("locked")) continue;
        ops.put(
            json("id", id, "expectedRevision", o.optLong("revision"), "value", JSONObject.NULL));
      } else if (action.equals("duplicate")) {
        n = jsonCopyMoved(n, 24, 24);
        String next = duplicates.get(id);
        try {
          n.put("id", next).put("revision", 0);
          for(String end:new String[]{"from","to"})if(duplicates.containsKey(n.optString(end)))n.put(end,duplicates.get(n.optString(end)));
        } catch (Exception ignored) {
        }
        ops.put(json("id", next, "expectedRevision", 0, "value", n));
      } else {
        try {
          if (action.equals("lock")) n.put("locked", !o.optBoolean("locked"));
          if (action.equals("front")) n.put("z", System.currentTimeMillis());
        } catch (Exception ignored) {
        }
        ops.put(json("id", id, "expectedRevision", o.optLong("revision"), "value", n));
      }
    }
    selected.clear();
    listener.selection(0);
    if (ops.length() > 0) commit(ops);
  }

  JSONObject jsonCopyMoved(JSONObject original, float dx, float dy) {
    JSONObject n = copy(original);
    try {
      n.put("x", n.optDouble("x",0) + dx);
      n.put("y", n.optDouble("y",0) + dy);
      JSONArray pts = n.optJSONArray("points");
      if (pts != null)
        for (int i = 0; i < pts.length(); i++) {
          JSONArray p = pts.getJSONArray(i);
          p.put(0, p.optDouble(0) + dx);
          p.put(1, p.optDouble(1) + dy);
        }
    } catch (Exception ignored) {
    }
    return n;
  }

  JSONObject jsonCopyScaled(JSONObject original,float factor) {
    JSONObject value=copy(original);String type=original.optString("type");
    try{
      if(!type.equals("ink")&&!type.equals("connector")||original.has("x"))value.put("x",transformBox.left+(original.optDouble("x")-transformBox.left)*factor);
      if(!type.equals("ink")&&!type.equals("connector")||original.has("y"))value.put("y",transformBox.top+(original.optDouble("y")-transformBox.top)*factor);
      if(!type.equals("ink")&&!type.equals("connector")||original.has("w"))value.put("w",original.optDouble("w",160)*factor);
      if(!type.equals("ink")&&!type.equals("connector")||original.has("h"))value.put("h",original.optDouble("h",60)*factor);
      value.put("width",original.optDouble("width",2)*factor);
      if(original.has("routeOffset"))value.put("routeOffset",original.optDouble("routeOffset")*factor);
      if(type.equals("text"))value.put("fontSize",original.optDouble("fontSize",22)*factor);
      JSONArray points=value.optJSONArray("points");
      if(points!=null)for(int n=0;n<points.length();n++){
        JSONArray point=points.getJSONArray(n);
        point.put(0,transformBox.left+(point.optDouble(0)-transformBox.left)*factor);
        point.put(1,transformBox.top+(point.optDouble(1)-transformBox.top)*factor);
      }
    }catch(JSONException error){throw new IllegalStateException("Redimensionnement impossible",error);}
    return value;
  }

  void updateTransform(float x,float y) {
    float dx=x-startX,dy=y-startY;
    if(!transformMoved && Math.hypot(dx*scale,dy*scale)<ViewConfiguration.get(getContext()).getScaledTouchSlop())return;
    if(transformMoved&&dx==transformDX&&dy==transformDY)return;
    transformMoved=true;transformDX=dx;transformDY=dy;
    if(resize&&proportionalResize){
      float w=Math.max(.1f,transformBox.width()),h=Math.max(.1f,transformBox.height());
      transformScale=Math.max(.05f,Math.min(100,1+(dx*w+dy*h)/(w*w+h*h)));
    }
    for(String id:before.keySet()){
      JSONObject original=before.get(id);if(original.optString("type").equals("ink"))continue;
      JSONObject value=original;
      if(resize&&proportionalResize){if(transformScale!=1)value=jsonCopyScaled(original,transformScale);}
      else if(dx!=0||dy!=0){
        if(resize){value=copy(original);try{value.put("w",Math.max(10,original.optDouble("w",100)+dx));value.put("h",Math.max(10,original.optDouble("h",100)+dy));}catch(JSONException error){throw new IllegalStateException(error);}}
        else value=jsonCopyMoved(original,dx,dy);
      }
      if(objects.get(id)!=value){objects.put(id,value);invalidateGeometry(id);}
    }
  }

  void finishTransform(boolean commitGesture) {
    if(!transform)return;
    if(commitGesture&&transformMoved)
      for(Map.Entry<String,JSONObject> entry:before.entrySet())if(entry.getValue().optString("type").equals("ink")){
        JSONObject value=entry.getValue();
        if(resize&&proportionalResize&&transformScale!=1)value=jsonCopyScaled(value,transformScale);
        else if(!resize&&(transformDX!=0||transformDY!=0))value=jsonCopyMoved(value,transformDX,transformDY);
        if(value!=entry.getValue()){objects.put(entry.getKey(),value);invalidateGeometry(entry.getKey());}
      }
    JSONArray ops=new JSONArray();Set<String> edited=new HashSet<>();
    for(Map.Entry<String,JSONObject> entry:before.entrySet()){
      String id=entry.getKey();JSONObject original=entry.getValue(),current=objects.get(id);
      if(commitGesture){
        if(!sameJson(original,current)){ops.put(json("id",id,"expectedRevision",original.optLong("revision"),"value",current));edited.add(id);}
      }else if(current!=original){objects.put(id,original);invalidateGeometry(id);}
    }
    transform=false;transformMoved=false;
    if(ops.length()>0)commit(ops);
    before.clear();
    boolean applied=false;
    for(Map.Entry<String,JSONObject> entry:deferredRemote.entrySet())if(!edited.contains(entry.getKey())){
      String id=entry.getKey();JSONObject value=entry.getValue();
      if(value.optBoolean("deleted"))objects.remove(id);else objects.put(id,value);
      invalidateGeometry(id);applied=true;
    }
    deferredRemote.clear();
    if(applied)listener.remoteApplied(this);
    if(selected.retainAll(objects.keySet()))listener.selection(selected.size());
    invalidate();
  }

  boolean inside(float x, float y) {
    boolean yes = false;
    for (int i = 0, j = lasso.size() - 1; i < lasso.size(); j = i++) {
      PointF a = lasso.get(i), b = lasso.get(j);
      if (((a.y > y) != (b.y > y)) && (x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x)) yes = !yes;
    }
    return yes;
  }

  @Override
  public boolean onTouchEvent(android.view.MotionEvent e) {
    if (!isEnabled()) return true;
    if (boox != null && boox.handles(e)) return true;
    if (e.getPointerCount() > 1) {
      for (int i = 0; i < e.getPointerCount(); i++)
        if (e.getToolType(i) == MotionEvent.TOOL_TYPE_STYLUS
            || e.getToolType(i) == MotionEvent.TOOL_TYPE_ERASER) {
          MotionEvent.PointerProperties properties = new MotionEvent.PointerProperties();
          MotionEvent.PointerCoords coords = new MotionEvent.PointerCoords();
          e.getPointerProperties(i, properties);
          e.getPointerCoords(i, coords);
          int penAction = e.getActionMasked();
          if (penAction == MotionEvent.ACTION_POINTER_DOWN
              || penAction == MotionEvent.ACTION_POINTER_UP)
            penAction =
                e.getActionIndex() == i
                    ? (penAction == MotionEvent.ACTION_POINTER_DOWN
                        ? MotionEvent.ACTION_DOWN
                        : MotionEvent.ACTION_UP)
                    : MotionEvent.ACTION_MOVE;
          MotionEvent pen =
              MotionEvent.obtain(
                  e.getDownTime(),
                  e.getEventTime(),
                  penAction,
                  1,
                  new MotionEvent.PointerProperties[] {properties},
                  new MotionEvent.PointerCoords[] {coords},
                  e.getMetaState(),
                  e.getButtonState(),
                  e.getXPrecision(),
                  e.getYPrecision(),
                  e.getDeviceId(),
                  e.getEdgeFlags(),
                  e.getSource(),
                  e.getFlags());
          try {
            return onTouchEvent(pen);
          } finally {
            pen.recycle();
          }
        }
    }
    boolean stylus =
        e.getToolType(0) == MotionEvent.TOOL_TYPE_STYLUS
            || e.getToolType(0) == MotionEvent.TOOL_TYPE_ERASER;
    int action = e.getActionMasked();
    if(action==MotionEvent.ACTION_DOWN)ignoreSelectionPointer=false;
    else if(ignoreSelectionPointer&&e.getPointerCount()==1){
      if(action==MotionEvent.ACTION_UP||action==MotionEvent.ACTION_CANCEL)ignoreSelectionPointer=false;
      return true;
    }
    if (drawing && !stylus) return true;
    if(action==MotionEvent.ACTION_DOWN||action==MotionEvent.ACTION_POINTER_DOWN)listener.interaction();
    if (!stylus) zoom.onTouchEvent(e);
    float x = (e.getX() - offsetX) / scale, y = (e.getY() - offsetY) / scale;
    if (e.getPointerCount() > 1) {
      finishTransform(false);
      panning = true;
      if (drawing) {
        drawing = false;
        live.reset();
      }
      return true;
    }
    if (action == MotionEvent.ACTION_DOWN) {
      finishTransform(false);
      inkGestureHistory = null;
      beginNativeInk();
      downX = e.getX();
      downY = e.getY();
      lastX = x;
      lastY = y;
      startX = x;
      startY = y;
      getParent().requestDisallowInterceptTouchEvent(true);
      panning = !stylus && (tool.equals("ink") || tool.equals("pan"));
      if (panning) return true;
      if (e.getToolType(0) == MotionEvent.TOOL_TYPE_ERASER || tool.equals("erase")) {
        erase(x, y);
        return true;
      }
      if (tool.equals("text")) {
        listener.text(x, y);
        return true;
      }
      if (tool.equals("select")) {
        boolean handle=nearSelectionHandle(x,y,stylus);
        String hit=handle?selected.iterator().next():hit(x,y);
        if(hit==null&&selected.size()>1&&selectedBounds().contains(x,y))hit=selected.iterator().next();
        if(hit!=null){
          if(!selected.contains(hit)){selected.clear();selected.add(hit);handle=nearSelectionHandle(x,y,stylus);}
          before.clear();
          for(String id:selected){JSONObject object=objects.get(id);if(object!=null&&!object.optBoolean("locked"))before.put(id,object);}
          transform=!before.isEmpty();transformMoved=false;transformDX=transformDY=0;transformScale=1;
          transformBox.set(selectedBounds());resize=handle;
          String type=objects.get(hit).optString("type");
          proportionalResize=resize&&(selected.size()>1||Arrays.asList("ink","image","text","arrow","connector").contains(type));
        }else{
          selected.clear();lasso.clear();lasso.add(new PointF(x,y));
        }
        listener.selection(selected.size());
        invalidate();
        return true;
      }
      drawing = true;
      points = new JSONArray();
      live.reset();
      live.moveTo(x, y);
      appendPoint(x, y, e.getPressure());
      invalidate();
      return true;
    }
    if (action == MotionEvent.ACTION_MOVE) {
      if (panning) {
        if (!zoom.isInProgress()) {
          offsetX += e.getX() - downX;
          offsetY += e.getY() - downY;
          downX = e.getX();
          downY = e.getY();
          invalidate();
        }
        return true;
      }
      if (e.getToolType(0) == MotionEvent.TOOL_TYPE_ERASER || tool.equals("erase")) {
        erase(x, y);
        return true;
      }
      if (transform) {
        updateTransform(x,y);
        invalidate();
        return true;
      }
      if (tool.equals("select")) {
        lasso.add(new PointF(x, y));
        invalidate();
        return true;
      }
      if (drawing) {
        for (int i = 0; i < e.getHistorySize(); i++)
          appendPoint(
              (e.getHistoricalX(i) - offsetX) / scale,
              (e.getHistoricalY(i) - offsetY) / scale,
              e.getHistoricalPressure(i));
        appendPoint(x, y, e.getPressure());
        lastX = x;
        lastY = y;
        if (android.os.SystemClock.uptimeMillis() - lastDraftTime > 350) {
          lastDraftTime = android.os.SystemClock.uptimeMillis();
          if (tool.equals("ink")) publishReachedInk();
          listener.draft(points);
        }
        invalidate();
      }
      return true;
    }
    if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
      if (panning) {
        panning = false;
        listener.viewport();
        return true;
      }
      if (transform) {
        if(action==MotionEvent.ACTION_UP)updateTransform(x,y);
        finishTransform(action==MotionEvent.ACTION_UP);
        return true;
      }
      if (tool.equals("select")) {
        if (lasso.size() > 2)
          for (JSONObject o : objects.values()) {
            RectF b = bounds(o);
            if (inside(b.centerX(), b.centerY())) selected.add(o.optString("id"));
          }
        lasso.clear();
        listener.selection(selected.size());
        invalidate();
        return true;
      }
      if (drawing) {
        drawing = false;
        if (action == MotionEvent.ACTION_UP) {
          if (tool.equals("ink")) appendPoint(x, y, e.getPressure());
          if (tool.equals("ink")) commitInkSegment();
          else if (Arrays.asList("rect", "ellipse", "arrow", "line").contains(tool))
            add(
                json(
                    "type",
                    tool,
                    "x",
                    (tool.equals("arrow") || tool.equals("line")) ? startX : Math.min(startX, x),
                    "y",
                    (tool.equals("arrow") || tool.equals("line")) ? startY : Math.min(startY, y),
                    "w",
                    (tool.equals("arrow") || tool.equals("line")) ? x - startX : Math.abs(x - startX),
                    "h",
                    (tool.equals("arrow") || tool.equals("line")) ? y - startY : Math.abs(y - startY)));
        }
        if (action == MotionEvent.ACTION_CANCEL && tool.equals("ink")) publishReachedInk();
        live.reset();
        listener.draft(new JSONArray());
        inkGestureHistory = null;
        invalidate();
      }
      return true;
    }
    return true;
  }

  long lastDraftTime = 0;

  void appendPoint(float x, float y, float pressure) {
    if (tool.equals("ink") && points.length() >= INK_SEGMENT_POINTS) {
      JSONArray last = points.optJSONArray(points.length() - 1);
      commitInkSegment();
      points = new JSONArray().put(last);
      nativeInkId = null; nativeInkCount = 0; nativeInkRevision = 0;
      live.reset();
      live.moveTo((float) last.optDouble(0), (float) last.optDouble(1));
      listener.draft(points);
    }
    try {
      points.put(new JSONArray().put(x).put(y).put(Math.max(0, Math.min(1, pressure))));
    } catch (JSONException ignored) {
    }
    live.lineTo(x, y);
    if (tool.equals("ink") && nativeInkCount == 0) publishReachedInk();
  }

  void commitInkSegment() {
    publishReachedInk();
  }

  void beginNativeInk() {
    nativeGestureId = UUID.randomUUID().toString(); nativeInkId = null;
    nativeInkCount = 0; nativeInkRevision = 0; rawSegmentIds.clear();
  }

  void publishReachedInk() {
    if (!tool.equals("ink") || points.length() <= nativeInkCount) return;
    if (nativeGestureId == null) beginNativeInk();
    if (nativeInkId == null) nativeInkId = UUID.randomUUID().toString();
    JSONArray fresh = new JSONArray(); for (int n = nativeInkCount; n < points.length(); n++) fresh.put(points.optJSONArray(n));
    JSONObject value = json("id", nativeInkId, "type", "ink", "points", points, "width", 2);
    JSONObject operation = json("id", nativeInkId, "expectedRevision", nativeInkRevision, "value", value);
    if (nativeInkCount > 0) try { operation.put("kind", "append").put("points", fresh); } catch (JSONException error) { throw new IllegalArgumentException(error); }
    nativeInkCount = points.length(); nativeInkRevision++;
    commitGesture(new JSONArray().put(operation), nativeGestureId);
  }

  /** BOOX can deliver both incremental samples and a final, corrected prefix. */
  void publishRawPrefix(JSONArray reached) {
    if (nativeGestureId == null) beginNativeInk();
    JSONArray operations = new JSONArray();
    int segment = 0;
    for (int offset = 0; offset < reached.length(); offset += INK_SEGMENT_POINTS - 1, segment++) {
      if (segment >= 128) throw new IllegalArgumentException("Le geste BOOX est trop long. Le préfixe déjà enregistré est conservé.");
      while (rawSegmentIds.size() <= segment) rawSegmentIds.add(UUID.randomUUID().toString());
      String id = rawSegmentIds.get(segment); JSONObject old = objects.get(id);
      JSONArray samples = new JSONArray(); for (int n = offset; n < Math.min(reached.length(), offset + INK_SEGMENT_POINTS); n++) samples.put(reached.optJSONArray(n));
      if (old != null && sameJson(old.optJSONArray("points"), samples)) continue;
      operations.put(json("id", id, "expectedRevision", old == null ? 0 : old.optLong("revision"), "value", json("id", id, "type", "ink", "points", samples, "width", 2)));
    }
    for (int n = segment; n < rawSegmentIds.size(); n++) { JSONObject old = objects.get(rawSegmentIds.get(n)); if (old != null) operations.put(json("id", old.optString("id"), "expectedRevision", old.optLong("revision"), "value", JSONObject.NULL)); }
    if (operations.length() > 0) commitGesture(operations, nativeGestureId);
  }

  void finishReachedInk() {
    if (boox != null && boox.capturing) boox.finishReached();
    if (drawing && tool.equals("ink")) publishReachedInk();
    drawing = false; live.reset();
  }

  void erase(float x, float y) {
    String id = hit(x, y);
    if (id != null && !objects.get(id).optBoolean("locked"))
      commit(
          new JSONArray()
              .put(
                  json(
                      "id",
                      id,
                      "expectedRevision",
                      objects.get(id).optLong("revision"),
                      "value",
                      JSONObject.NULL)));
  }
}
