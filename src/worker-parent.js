// Only MCP-managed CLI workers have an IPC parent. If that parent is killed,
// budget cancellation saves progress; this watchdog bounds a hung shutdown too.
export function watchWorkerParent({ runtime = process, graceMs = 20000 } = {}) {
  if(runtime.env.BFS_MCP_WORKER!=='1'||typeof runtime.send!=='function')return ()=>{};
  let timer=null,lost=false;
  const disconnect=()=>{
    if(lost)return;lost=true;
    timer=setTimeout(()=>runtime.exit(1),graceMs);timer.unref();
  };
  runtime.once('disconnect',disconnect);
  // Covers loss before module evaluation or before the listener was installed.
  if(!runtime.connected)disconnect();
  return ()=>{clearTimeout(timer);runtime.off('disconnect',disconnect);};
}
