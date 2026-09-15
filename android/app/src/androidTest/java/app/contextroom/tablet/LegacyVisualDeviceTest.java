package app.contextroom.tablet;

import android.app.Instrumentation;
import android.graphics.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import java.io.*;
import java.util.*;
import static org.junit.Assert.*;

/** Actual native drawing primitives, with synthetic legacy presentation fields. */
@RunWith(AndroidJUnit4.class)
public final class LegacyVisualDeviceTest {
  @Test public void importedPresentationKeepsRoutesAndTextBaselines() {
    Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    instrumentation.runOnMainSync(() -> {
      InkView view = new InkView(instrumentation.getTargetContext(), new InkView.Listener() {
        public void change(JSONArray operations) {} public void viewport() {} public void text(float x, float y) {}
        public void selection(int count) {} public void draft(JSONArray points) {}
      });
      Bitmap image = Bitmap.createBitmap(640, 440, Bitmap.Config.ARGB_8888);
      ArrayList<Float> baselines = new ArrayList<>();
      Canvas canvas = new Canvas(image) {
        @Override public void drawText(String text, float x, float y, Paint paint) { baselines.add(y); super.drawText(text, x, y, paint); }
      };
      try {
        canvas.drawColor(Color.WHITE);
        JSONObject upper = InkView.json("id","upper","type","rect","x",200,"y",100,"w",120,"h",50);
        JSONObject lower = InkView.json("id","lower","type","rect","x",200,"y",300,"w",120,"h",50);
        JSONObject connector = InkView.json("id","return","type","connector","from","upper","to","lower","fromSide","left","toSide","left","route","outside-left","routeOffset",48);
        JSONObject text = InkView.json("id","label","type","text","x",350,"y",100,"w",180,"h",100,"fontSize",22,"lineHeight",1.4,"text","Original\nSecond line");
        for (JSONObject value : Arrays.asList(upper,lower,connector,text)) view.objects.put(value.optString("id"),value);
        assertArrayEquals(new float[]{200,125,152,125,152,325,200,325},view.lineRoute(connector,new HashSet<>()),0f);
        for (JSONObject value : Arrays.asList(upper,lower,connector,text)) view.drawObject(canvas,value,false);
        assertEquals(Arrays.asList(122f,152.8f),baselines);
        assertTrue(Color.red(image.getPixel(152,225))<128);
        JSONObject linear = InkView.json("id","legacy-ink","type","ink","width",20,"pressureCurve","linear","points",new JSONArray("[[50,390.5,0.1],[250,390.5,0.1]]"));
        JSONObject soft = InkView.json("id","current-ink","type","ink","width",20,"points",new JSONArray("[[50,420.5,0.1],[250,420.5,0.1]]"));
        float[] inputs={0f,.1f,.5f,1f},expectedLinear={.15f,.15f,.5f,1f},expectedSoft={.2f,.28f,.6f,1f};
        for(int index=0;index<inputs.length;index++){
          JSONArray point=new JSONArray().put(0).put(0).put(inputs[index]);
          assertEquals(expectedLinear[index],InkView.inkPressure(linear,point),.00001f);
          assertEquals(expectedSoft[index],InkView.inkPressure(soft,point),.00001f);
        }
        view.drawObject(canvas,linear,false);view.drawObject(canvas,soft,false);
        assertEquals(Color.WHITE,image.getPixel(100,392));
        assertTrue(Color.red(image.getPixel(100,422))<128);
        File target = new File(instrumentation.getTargetContext().getCacheDir(),"legacy-editable-native.png");
        try (FileOutputStream output = new FileOutputStream(target)) { assertTrue(image.compress(Bitmap.CompressFormat.PNG,100,output)); }
      } catch (IOException|JSONException failure) { throw new AssertionError(failure); }
      finally { image.recycle(); }
    });
  }
}
