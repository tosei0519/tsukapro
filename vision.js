/* Pure image functions, also usable from Node tests. No image leaves the browser. */
(function(root){
const SIZE=64;
function components(image,threshold=null){
 const {width:w,height:h,data}=image,mask=new Uint8Array(w*h),seen=new Uint8Array(w*h),queue=new Int32Array(w*h),out=[];
 // White material: reject saturated wood before brightness segmentation.
 const hist=new Uint32Array(256);let total=0;
 for(let i=0;i<mask.length;i++){const r=data[i*4],g=data[i*4+1],b=data[i*4+2],hi=Math.max(r,g,b),lo=Math.min(r,g,b);if(hi-lo<=Math.max(16,hi*.22)){hist[Math.round((r+g+b)/3)]++;total++;}}
 if(threshold==null){let sum=0;for(let i=0;i<256;i++)sum+=i*hist[i];let count=0,part=0,best=-1,cut=100;for(let i=0;i<255;i++){count+=hist[i];part+=i*hist[i];if(!count||count===total)continue;const score=count*(total-count)*(part/count-(sum-part)/(total-count))**2;if(score>best){best=score;cut=i;}}threshold=Math.max(75,Math.min(195,cut+8));}
 for(let i=0;i<mask.length;i++){const r=data[i*4],g=data[i*4+1],b=data[i*4+2],hi=Math.max(r,g,b),lo=Math.min(r,g,b);mask[i]=hi-lo<=Math.max(16,hi*.22)&&(r+g+b)/3>=threshold&&data[i*4+3]>128?1:0;}
 for(let seed=0;seed<mask.length;seed++){
  if(!mask[seed]||seen[seed])continue;
  let head=0,tail=0,minX=w,minY=h,maxX=0,maxY=0;queue[tail++]=seed;seen[seed]=1;
  while(head<tail){const p=queue[head++],x=p%w,y=Math.floor(p/w);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
   for(const n of [x>0?p-1:-1,x<w-1?p+1:-1,y>0?p-w:-1,y<h-1?p+w:-1])if(n>=0&&mask[n]&&!seen[n]){seen[n]=1;queue[tail++]=n;}
  }
  if(tail<Math.max(80,w*h*.0007)||maxX-minX<10||maxY-minY<10)continue;
  // Reject the white background / objects cut off by the image edge.
  if(minX===0||minY===0||maxX===w-1||maxY===h-1)continue;
  const bw=maxX-minX+1,bh=maxY-minY+1,local=new Uint8Array(bw*bh);
  for(let j=0;j<tail;j++){const p=queue[j];local[(Math.floor(p/w)-minY)*bw+p%w-minX]=1;}
  // Flood exterior darkness; enclosed decoration is filled in to retain silhouette.
  const outside=new Uint8Array(local.length),q=new Int32Array(local.length);let a=0,b=0;
  const add=p=>{if(!local[p]&&!outside[p]){outside[p]=1;q[b++]=p;}};
  for(let x=0;x<bw;x++){add(x);add((bh-1)*bw+x);}for(let y=0;y<bh;y++){add(y*bw);add(y*bw+bw-1);}
  while(a<b){const p=q[a++],x=p%bw,y=Math.floor(p/bw);if(x)add(p-1);if(x<bw-1)add(p+1);if(y)add(p-bw);if(y<bh-1)add(p+bw);}
  // Align a slightly tilted horizontal block using second moments of its silhouette.
  let n=0,cx=0,cy=0;for(let y=0;y<bh;y++)for(let x=0;x<bw;x++)if(!outside[y*bw+x]){n++;cx+=x;cy+=y;}cx/=n;cy/=n;
  let xx=0,yy=0,xy=0;for(let y=0;y<bh;y++)for(let x=0;x<bw;x++)if(!outside[y*bw+x]){xx+=(x-cx)**2;yy+=(y-cy)**2;xy+=(x-cx)*(y-cy);}
  let angle=.5*Math.atan2(2*xy,xx-yy);if(Math.abs(angle)>.44)angle=0;
  const co=Math.cos(angle),si=Math.sin(angle);let lx=Infinity,ly=Infinity,hx=-Infinity,hy=-Infinity;
  for(let y=0;y<bh;y++)for(let x=0;x<bw;x++)if(!outside[y*bw+x]){const u=(x-cx)*co+(y-cy)*si,v=-(x-cx)*si+(y-cy)*co;lx=Math.min(lx,u);hx=Math.max(hx,u);ly=Math.min(ly,v);hy=Math.max(hy,v);}
  const rw=hx-lx+1,rh=hy-ly+1,bits=[],side=Math.max(rw,rh),ox=(side-rw)/2,oy=(side-rh)/2;
  for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE;x++){const u=(x+.5)*side/SIZE-ox+lx,v=(y+.5)*side/SIZE-oy+ly,sx=Math.round(u*co-v*si+cx),sy=Math.round(u*si+v*co+cy);bits.push(sx>=0&&sx<bw&&sy>=0&&sy<bh&&!outside[sy*bw+sx]?1:0);}
  out.push({x:minX,y:minY,w:bw,h:bh,area:tail,bits,aspect:rw/rh});
 }
 return out;
}
function upsample(bits){if(bits.length===SIZE*SIZE)return bits;const old=Math.sqrt(bits.length);return Array.from({length:SIZE*SIZE},(_,i)=>bits[Math.floor(Math.floor(i/SIZE)*old/SIZE)*old+Math.floor(i%SIZE*old/SIZE)]||0);}
function similarity(a,b){a=upsample(a);b=upsample(b);let best=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){let intersection=0,union=0;for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE;x++){const xx=x+dx,yy=y+dy,A=a[y*SIZE+x],B=xx>=0&&xx<SIZE&&yy>=0&&yy<SIZE?b[yy*SIZE+xx]:0,weight=x<SIZE*.24||x>SIZE*.76?4:1;if(A||B)union+=weight;if(A&&B)intersection+=weight;}best=Math.max(best,union?intersection/union:0);}return best;}
function classify(bits,library){const ranks=Object.entries(library).map(([code,item])=>({code,score:Math.max(...(item.samples||[item.bits]).map(b=>similarity(bits,b)))})).sort((a,b)=>b.score-a.score);const best=ranks[0];return {code:best&&best.score>=.83&&(!ranks[1]||best.score-ranks[1].score>=.018)?best.code:'?',suggested:best?.code||null,score:best?.score||0,margin:best?best.score-(ranks[1]?.score||0):0};}
const api={SIZE,components,similarity,classify,upsample};if(typeof module!=='undefined')module.exports=api;else root.ShapeVision=api;
})(typeof window!=='undefined'?window:globalThis);
