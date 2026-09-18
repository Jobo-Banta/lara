export async function GET() {
 try {
  const r=await fetch((process.env.API_INTERNAL_URL||'http://127.0.0.1:4000')+'/health/ready',{cache:'no-store',signal:AbortSignal.timeout(4000)});
  return Response.json({ready:r.ok},{status:r.ok?200:503,headers:{'cache-control':'no-store'}});
 } catch {return Response.json({ready:false},{status:503});}
}
