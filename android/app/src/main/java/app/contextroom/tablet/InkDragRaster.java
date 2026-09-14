package app.contextroom.tablet;

import android.graphics.*;
import android.os.*;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;

/** Disposable per-stroke previews. Object order is still painted by InkView;
 * neither persisted geometry nor snapshots depend on these small rasters. */
final class InkDragRaster {
  final InkView view;
  final Map<String,Tile> tiles=new HashMap<>();
  final Handler ui=new Handler(Looper.getMainLooper());
  final Paint paint=new Paint(Paint.FILTER_BITMAP_FLAG);
  ExecutorService worker;
  Job running;
  boolean closed,failed;
  long generation,hits;
  static final class Tile {
    JSONObject source; RectF world; float scale; int width,height;
    Picture picture; Bitmap bitmap;
    long bytes(){return 4L*width*height;}
  }
  static final class Job {
    long generation,bytes; volatile boolean cancelled,failed;
    final Map<String,Tile> tiles=new LinkedHashMap<>();
  }
  InkDragRaster(InkView view){this.view=view;}
  long allocatedBytes(){long bytes=running==null?0:running.bytes;for(Tile tile:tiles.values())bytes+=tile.bytes();return bytes;}
  void clear(){failed=false;generation++;if(running!=null)running.cancelled=true;for(Tile tile:tiles.values())tile.bitmap.recycle();tiles.clear();}
  void close(){closed=true;clear();if(worker!=null)worker.shutdown();}
  void activate(){closed=false;}
  boolean draw(Canvas canvas,JSONObject object){
    Tile tile=tiles.get(object.optString("id"));
    if(tile==null||tile.source!=object||tile.scale!=view.scale)return false;
    canvas.drawBitmap(tile.bitmap,null,tile.world,paint);hits++;return true;
  }
  void prepare(){
    if(closed||view.snapshotRecording||view.selected.isEmpty()){if(!tiles.isEmpty()||running!=null||failed)clear();return;}
    if(running!=null||failed)return;
    Iterator<Tile> old=tiles.values().iterator();while(old.hasNext()){
      Tile tile=old.next();if(view.objects.get(tile.source.optString("id"))!=tile.source||tile.scale!=view.scale){tile.bitmap.recycle();old.remove();}
    }
    long available=Math.min(view.sceneCache.budget/3-allocatedBytes(),view.sceneCache.budget-view.sceneCache.allocatedBytes());
    if(available<=0)return;
    Job job=new Job();job.generation=generation;
    for(JSONObject object:view.objects.values()){
      String id=object.optString("id");if(!object.optString("type").equals("ink")||tiles.containsKey(id))continue;
      JSONArray points=object.optJSONArray("points");if(points==null||points.length()<128)continue;
      // Keep complete objects, including currently offscreen parts. A drag may reveal them.
      RectF box=view.rawInkBounds(object);float scale=view.scale;
      float left=(float)Math.floor(box.left*scale)-2,top=(float)Math.floor(box.top*scale)-2;
      double width=Math.ceil(box.right*scale)+2-left,height=Math.ceil(box.bottom*scale)+2-top;
      if(width<=0||height<=0||width>8192||height>8192||4*width*height>available-job.bytes)continue;
      Tile tile=new Tile();tile.source=object;tile.scale=scale;tile.width=(int)width;tile.height=(int)height;
      tile.world=new RectF(left/scale,top/scale,(left+tile.width)/scale,(top+tile.height)/scale);
      tile.picture=new Picture();Canvas canvas=tile.picture.beginRecording(tile.width,tile.height);
      canvas.translate(-left,-top);canvas.scale(scale,scale);
      Paint ink=new Paint(Paint.ANTI_ALIAS_FLAG);ink.setColor(Color.BLACK);ink.setStyle(Paint.Style.FILL);canvas.drawPath(view.path(object),ink);tile.picture.endRecording();
      job.tiles.put(id,tile);job.bytes+=tile.bytes();if(job.tiles.size()>=512)break;
    }
    if(job.tiles.isEmpty())return;
    if(worker==null||worker.isShutdown())worker=Executors.newSingleThreadExecutor();running=job;
    worker.execute(()->{
      try{for(Tile tile:job.tiles.values()){if(job.cancelled)break;tile.bitmap=Bitmap.createBitmap(tile.width,tile.height,Bitmap.Config.ARGB_8888);new Canvas(tile.bitmap).drawPicture(tile.picture);tile.picture=null;}}
      catch(RuntimeException|OutOfMemoryError error){job.cancelled=true;job.failed=true;android.util.Log.w("ContextRoom","Drag preview unavailable",error);}
      ui.post(()->{
        if(running==job)running=null;
        if(job.failed&&!closed&&job.generation==generation)failed=true;
        for(Map.Entry<String,Tile> entry:job.tiles.entrySet()){
          Tile tile=entry.getValue();tile.picture=null;
          if(!closed&&!job.cancelled&&job.generation==generation&&view.objects.get(entry.getKey())==tile.source&&view.scale==tile.scale&&tile.bitmap!=null)tiles.put(entry.getKey(),tile);
          else if(tile.bitmap!=null)tile.bitmap.recycle();
        }
        if(!closed)view.invalidate();
      });
    });
  }
}
