import com.switchboard.domain.ai.stats.MixtureSequentialTest;
public class JavaVals {
  public static void main(String[] a) {
    long[][] c = {{20,400,20,400},{80,400,20,400},{4,400,80,400},{40,1000,20,1000},{200,1000,20,1000},{9000,100000,100,100000},{21,200,4,200},{55,4800,40,4800},{5,100,5,100},{1,2,0,2}};
    double[] taus = {0.01,0.02,0.15};
    StringBuilder sb = new StringBuilder("[");
    boolean first = true;
    for (long[] x : c) for (double t : taus) {
      double v = MixtureSequentialTest.logEValueOneSided(x[0],x[1],x[2],x[3],t);
      if (!first) sb.append(","); first = false;
      sb.append(String.format("{\"args\":[%d,%d,%d,%d,%s],\"logE\":%s}", x[0],x[1],x[2],x[3], Double.toString(t), Double.toString(v)));
    }
    System.out.println(sb.append("]"));
  }
}
