package app.contextroom.tablet;

import android.graphics.*;
import android.view.View;
import android.os.*;
import java.util.concurrent.*;
import java.util.*;
import org.json.*;

/** Screen-only raster. Large changes use an immutable recording and one worker;
 * live ink and newly committed topmost objects stay visible independently. */
final class InkSceneCache {
  static Bitmap capture(Picture picture) {
    Bitmap image = Bitmap.createBitmap(picture.getWidth(), picture.getHeight(), Bitmap.Config.ARGB_8888);
    new Canvas(image).drawPicture(picture);
    return image;
  }
  final InkView view;
  final long budget=Math.min(32L*1024*1024,Runtime.getRuntime().maxMemory()/8);
  final Set<String> changed=new HashSet<>(),errors=new HashSet<>();
  final Map<String,RectF> extents=new HashMap<>();
  final Map<String,Bitmap> images=new HashMap<>();
  final Paint measure=new Paint(Paint.ANTI_ALIAS_FLAG);
  Bitmap bitmap;float x,y,scale,paintedX,paintedY,paintedScale=1;int plannedWidth,plannedHeight;long refusedSize;
  final Handler ui=new Handler(Looper.getMainLooper());
  final Map<String,JSONObject> additions=new LinkedHashMap<>();
  ExecutorService worker;Job running;
  long epoch,wantedVersion,shownVersion,asyncSubmitted,asyncApplied,asyncDiscarded,maxRecordMs;
  boolean syncRequired,gone;
  static final class Job {
    Picture picture;long epoch,version,bytes;int width,height;float x,y,scale;
    volatile boolean cancelled;final Map<String,JSONObject> additions=new HashMap<>();
  }
  long fullRenders,partialRenders,reuses;
  InkSceneCache(InkView view){this.view=view;}
  void changed(String id){
    changed.add(id);
    JSONObject current=view.objects.get(id),overlay=additions.get(id);
    if(current==null)cancelRaster();
    if(overlay!=null&&!sameAppearance(overlay,current))requireSynchronous();
    for(JSONObject value:additions.values())if(value.optString("type").equals("connector")&&(id.equals(value.optString("from"))||id.equals(value.optString("to"))))requireSynchronous();
  }
  static boolean sameAppearance(JSONObject first,JSONObject second){
    if(first==null||second==null)return first==second;
    Set<String> keys=new HashSet<>();first.keys().forEachRemaining(keys::add);second.keys().forEachRemaining(keys::add);
    for(String key:keys)if(!key.equals("revision")&&!key.equals("actor")&&!InkView.sameJson(first.opt(key),second.opt(key)))return false;return true;
  }
  void localChange(String id,boolean added){
    JSONObject value=view.objects.get(id);
    if(!added||value==null||additions.size()>=64){requireSynchronous();return;}
    for(JSONObject other:view.objects.values())if(other!=value&&other.optDouble("z",0)>value.optDouble("z",0)){requireSynchronous();return;}
    additions.put(id,value);
  }
  void requireSynchronous(){syncRequired=true;cancelRaster();}
  void cancelRaster(){epoch++;if(running!=null)running.cancelled=true;}
  // Includes the worker's reservation, even before its bitmap is allocated.
  long allocatedBytes(){return view.dragRaster.allocatedBytes()+(bitmap==null?0:bitmap.getAllocationByteCount())+(running==null?0:running.bytes);}
  long displayedBytes(){return bitmap==null?0:bitmap.getAllocationByteCount();}
  void clear(){cancelRaster();bitmap=null;changed.clear();errors.clear();extents.clear();images.clear();additions.clear();plannedWidth=plannedHeight=0;refusedSize=0;shownVersion=wantedVersion;}
  // Let the single queued job run its cancellation check and completion callback.
  void close(){gone=true;clear();if(worker!=null)worker.shutdown();}
  void activate(){gone=false;}
  boolean idle(){return running==null&&wantedVersion==shownVersion;}

  boolean draw(Canvas output){
    if(view.snapshotRecording||output.isHardwareAccelerated())return false;
    int width=view.getWidth(),height=view.getHeight();long bytes=4L*width*height;
    if(view.getLayerType()!=View.LAYER_TYPE_SOFTWARE||width<=0||height<=0||bytes>budget){clear();return false;}
    if(bitmap==null&&refusedSize==bytes)return false;
    if(bytes+view.dragRaster.allocatedBytes()+(running==null?0:running.bytes)>budget){clear();return false;}
    boolean imageChange=!images.equals(view.images)||!errors.equals(view.imageErrors);
    if(imageChange&&!additions.isEmpty())requireSynchronous();
    boolean full=plannedWidth!=width||plannedHeight!=height||x!=view.offsetX||y!=view.offsetY||scale!=view.scale||imageChange;
    RectF damage=new RectF();
    if(full){
      extents.clear();for(JSONObject object:view.objects.values())extents.put(object.optString("id"),extent(object));
    }else{
      Set<String> dirty=new HashSet<>(changed);
      // Connectors depend on other objects, even when their own revision stays unchanged.
      if(!changed.isEmpty())for(JSONObject object:view.objects.values())if(object.optString("type").equals("connector"))dirty.add(object.optString("id"));
      for(String id:dirty){
        RectF old=extents.remove(id);if(old!=null)damage.union(old);
        JSONObject object=view.objects.get(id);if(object!=null){RectF next=extent(object);extents.put(id,next);damage.union(next);}
      }
    }
    if(!full&&!damage.isEmpty()){
      // Repaint whole intersecting primitives. Skia can rasterize a clipped
      // stroke differently; changing an unrelated selection must not alter its
      // antialiasing or leave a seam. Expand until no primitive crosses the edge.
      RectF visible=new RectF(-view.offsetX/view.scale,-view.offsetY/view.scale,
          (width-view.offsetX)/view.scale,(height-view.offsetY)/view.scale);
      boolean expanded;
      do{expanded=false;for(RectF bounds:extents.values())if(RectF.intersects(bounds,visible)&&RectF.intersects(bounds,damage)&&!damage.contains(bounds)){damage.union(bounds);expanded=true;}}while(expanded);
    }
    boolean updated=full||!damage.isEmpty();
    boolean wasCurrent=wantedVersion==shownVersion&&running==null;
    if(updated){
      wantedVersion++;x=view.offsetX;y=view.offsetY;scale=view.scale;plannedWidth=width;plannedHeight=height;
      images.clear();images.putAll(view.images);errors.clear();errors.addAll(view.imageErrors);
    }
    changed.clear();
    boolean expensive=full||damage.width()*damage.height()*scale*scale>width*(double)height/5;
    boolean asynchronous=view.isAttachedToWindow()&&!gone&&!view.transform&&!syncRequired&&bitmap!=null&&bytes+displayedBytes()+view.dragRaster.allocatedBytes()<=budget;
    if(wantedVersion!=shownVersion){
      if(!asynchronous||(updated&&wasCurrent&&!expensive)){
        cancelRaster();full=full||!wasCurrent||syncRequired||bitmap==null;syncRequired=false;
        if(bitmap==null||bitmap.getWidth()!=width||bitmap.getHeight()!=height){
          bitmap=null;
          try{bitmap=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888);}catch(OutOfMemoryError unavailable){clear();refusedSize=bytes;return false;}
        }
        Canvas canvas=new Canvas(bitmap);
        if(!full)canvas.clipRect((float)Math.floor(damage.left*scale+x),(float)Math.floor(damage.top*scale+y),(float)Math.ceil(damage.right*scale+x),(float)Math.ceil(damage.bottom*scale+y));
        paintScene(canvas,full?null:damage);
        if(full)fullRenders++;else partialRenders++;
        shownVersion=wantedVersion;paintedX=x;paintedY=y;paintedScale=scale;additions.clear();
      }else if(running==null)startRaster(width,height,bytes);
    }else reuses++;
    if(bitmap==null)return false;
    float ratio=view.scale/paintedScale;
    output.save();output.translate(view.offsetX-paintedX*ratio,view.offsetY-paintedY*ratio);output.scale(ratio,ratio);output.drawBitmap(bitmap,0,0,null);output.restore();
    if(!additions.isEmpty()){
      output.save();output.translate(view.offsetX,view.offsetY);output.scale(view.scale,view.scale);
      for(JSONObject object:additions.values())view.drawObject(output,object,true);
      output.restore();
    }
    return true;
  }

  void paintScene(Canvas canvas,RectF damage){
    canvas.drawColor(Color.WHITE);canvas.translate(x,y);canvas.scale(scale,scale);
    RectF visible=new RectF(-x/scale,-y/scale,(plannedWidth-x)/scale,(plannedHeight-y)/scale);
    List<JSONObject> sorted=new ArrayList<>(view.objects.values());sorted.sort(Comparator.comparingDouble(o->o.optDouble("z",0)));
    for(JSONObject object:sorted){RectF bounds=extents.get(object.optString("id"));if(bounds!=null&&RectF.intersects(bounds,visible)&&(damage==null||RectF.intersects(bounds,damage)))view.drawObject(canvas,object,true);}
  }
  void startRaster(int width,int height,long bytes){
    Job job=new Job();job.epoch=epoch;job.version=wantedVersion;job.width=width;job.height=height;job.bytes=bytes;job.x=x;job.y=y;job.scale=scale;job.additions.putAll(additions);
    long started=SystemClock.elapsedRealtime();job.picture=new Picture();Canvas recording=job.picture.beginRecording(width,height);paintScene(recording,null);job.picture.endRecording();maxRecordMs=Math.max(maxRecordMs,SystemClock.elapsedRealtime()-started);
    if(worker==null||worker.isShutdown())worker=Executors.newSingleThreadExecutor();running=job;asyncSubmitted++;
    worker.execute(()->{
      Bitmap result=null;Throwable failure=null;
      try{if(!job.cancelled){result=InkSceneCache.capture(job.picture);if(job.cancelled){result.recycle();result=null;}}}
      catch(Exception|OutOfMemoryError problem){failure=problem;}
      Bitmap ready=result;Throwable error=failure;ui.post(()->{
        if(running==job)running=null;
        // Present monotonically newer completed frames during a continuous gesture.
        // Requiring equality with wantedVersion would starve every slow raster.
        // Deletion, undo and leaving the view invalidate the epoch independently.
        if(!gone&&!job.cancelled&&job.epoch==epoch&&job.version>=shownVersion&&ready!=null){
          bitmap=ready;shownVersion=job.version;paintedX=job.x;paintedY=job.y;paintedScale=job.scale;asyncApplied++;
          for(Map.Entry<String,JSONObject> entry:job.additions.entrySet())if(additions.get(entry.getKey())==entry.getValue())additions.remove(entry.getKey());
        }else{if(ready!=null)ready.recycle();asyncDiscarded++;}
        if(error!=null&&!gone&&!job.cancelled){android.util.Log.w("ContextRoom","Background canvas raster unavailable",error);syncRequired=true;}
        if(!gone)view.invalidate();
      });
    });
  }

  RectF extent(JSONObject object){
    RectF result=view.bounds(object);String type=object.optString("type");
    if(type.equals("text")){
      float size=(float)object.optDouble("fontSize",22);measure.setTextSize(size);Paint.FontMetrics metrics=measure.getFontMetrics();float baseline=result.top+size;
      for(String line:object.optString("text").split("\n")){result.union(result.left,baseline+metrics.top,result.left+measure.measureText(line),baseline+metrics.bottom);baseline+=size*1.4f;}
    }else if(type.equals("image")&&!view.images.containsKey(object.optString("assetId"))){
      measure.setTextSize(16);String label=view.imageErrors.contains(object.optString("assetId"))?"Image indisponible":"Chargement de l’image…";
      result.union(result.left+8,result.top+24+measure.getFontMetrics().top,result.left+8+measure.measureText(label),result.top+24+measure.getFontMetrics().bottom);
    }
    float pad=Math.max(12/view.scale,(float)object.optDouble("width",2)/2+2/view.scale);
    if(type.equals("arrow")||type.equals("connector"))pad+=12;
    result.inset(-pad,-pad);return result;
  }
}
