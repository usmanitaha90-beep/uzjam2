export function coefficients(filter, sampleRate) {
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) throw new Error("invalid sample rate");
  if (!(filter.frequencyHz > 0 && filter.frequencyHz < sampleRate / 2)) throw new Error("invalid frequency");
  if (!(filter.q > 0) || !Number.isFinite(filter.q)) throw new Error("invalid Q");
  const w0 = 2 * Math.PI * filter.frequencyHz / sampleRate;
  const c = Math.cos(w0), s = Math.sin(w0), alpha = s / (2 * filter.q);
  const shelfAlpha = s / 2 * Math.SQRT2;
  const A = Math.pow(10, filter.gainDb / 40), sqrtA = Math.sqrt(A);
  let b0,b1,b2,a0,a1,a2;
  switch(filter.kind) {
    case "peak": [b0,b1,b2,a0,a1,a2]=[1+alpha*A,-2*c,1-alpha*A,1+alpha/A,-2*c,1-alpha/A]; break;
    case "lowShelf": [b0,b1,b2,a0,a1,a2]=[
      A*((A+1)-(A-1)*c+2*sqrtA*shelfAlpha), 2*A*((A-1)-(A+1)*c), A*((A+1)-(A-1)*c-2*sqrtA*shelfAlpha),
      (A+1)+(A-1)*c+2*sqrtA*shelfAlpha, -2*((A-1)+(A+1)*c), (A+1)+(A-1)*c-2*sqrtA*shelfAlpha]; break;
    case "highShelf": [b0,b1,b2,a0,a1,a2]=[
      A*((A+1)+(A-1)*c+2*sqrtA*shelfAlpha), -2*A*((A-1)+(A+1)*c), A*((A+1)+(A-1)*c-2*sqrtA*shelfAlpha),
      (A+1)-(A-1)*c+2*sqrtA*shelfAlpha, 2*((A-1)-(A+1)*c), (A+1)-(A-1)*c-2*sqrtA*shelfAlpha]; break;
    case "lowPass": [b0,b1,b2,a0,a1,a2]=[(1-c)/2,1-c,(1-c)/2,1+alpha,-2*c,1-alpha]; break;
    case "highPass": [b0,b1,b2,a0,a1,a2]=[(1+c)/2,-(1+c),(1+c)/2,1+alpha,-2*c,1-alpha]; break;
    case "notch": [b0,b1,b2,a0,a1,a2]=[1,-2*c,1,1+alpha,-2*c,1-alpha]; break;
    case "bandPass": [b0,b1,b2,a0,a1,a2]=[alpha,0,-alpha,1+alpha,-2*c,1-alpha]; break;
    case "allPass": [b0,b1,b2,a0,a1,a2]=[1-alpha,-2*c,1+alpha,1+alpha,-2*c,1-alpha]; break;
    default: throw new Error(`unsupported kind ${filter.kind}`);
  }
  return {b0:b0/a0,b1:b1/a0,b2:b2/a0,a1:a1/a0,a2:a2/a0};
}

export function magnitudeDb(filter, sampleRate, frequency) {
  const q=coefficients(filter,sampleRate), w=2*Math.PI*frequency/sampleRate;
  const z1=[Math.cos(w),-Math.sin(w)], z2=[Math.cos(2*w),-Math.sin(2*w)];
  const nr=q.b0+q.b1*z1[0]+q.b2*z2[0], ni=q.b1*z1[1]+q.b2*z2[1];
  const dr=1+q.a1*z1[0]+q.a2*z2[0], di=q.a1*z1[1]+q.a2*z2[1];
  return 20*Math.log10(Math.max(1e-12,Math.hypot(nr,ni))/Math.max(1e-12,Math.hypot(dr,di)));
}
