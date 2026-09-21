(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const qsa = (selector, root=document) => [...root.querySelectorAll(selector)];

  const pageMeta = {
    dashboard:["Change-control overview","Overview"],
    devices:["Network inventory","Device Rack"],
    backups:["Version history","Backups"],
    compare:["Change analysis","Compare"],
    schedules:["Automation","Schedules"],
    audit:["Traceability","Audit"],
    about:["Project architecture","About"]
  };

  const state = {
    mode:localStorage.getItem("config_backup_mode") || (location.port==="8800"?"live":"demo"),
    backendUrl:localStorage.getItem("config_backup_backend_url") || (location.port==="8800"?location.origin:"http://127.0.0.1:8800"),
    data:null,
    activePage:"dashboard",
    selectedDevice:null,
    selectedBackup:null,
    lastRefresh:null
  };

  function esc(v){
    return String(v??"")
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#039;");
  }

  function fmtTime(iso){
    if(!iso)return "Never";
    const d=new Date(iso);
    if(Number.isNaN(d.getTime()))return String(iso);
    const diff=Math.max(0,Date.now()-d.getTime());
    if(diff<60000)return "just now";
    if(diff<3600000)return Math.round(diff/60000)+"m ago";
    if(diff<86400000)return Math.round(diff/3600000)+"h ago";
    return Math.round(diff/86400000)+"d ago";
  }

  function fmtBytes(bytes){
    let n=Number(bytes)||0;
    const units=["B","KB","MB","GB"];
    let i=0;
    while(n>=1024&&i<units.length-1){n/=1024;i++}
    return n.toFixed(n>=10||i===0?0:1)+" "+units[i];
  }

  function toast(title,message="",type="info"){
    const node=document.createElement("div");
    node.className="toast "+type;
    node.innerHTML="<strong>"+esc(title)+"</strong><span>"+esc(message)+"</span>";
    $("toastRegion").appendChild(node);
    setTimeout(()=>node.remove(),4300);
  }

  function cloneDemo(){
    const saved=sessionStorage.getItem("config_backup_demo_state");
    if(saved){try{return JSON.parse(saved)}catch{}}
    return JSON.parse(JSON.stringify(window.CONFIG_BACKUP_DEMO));
  }

  function persistDemo(){
    if(state.mode==="demo")sessionStorage.setItem("config_backup_demo_state",JSON.stringify(state.data));
  }

  async function fetchJson(path,options={}){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),options.timeout||15000);
    try{
      const response=await fetch(state.backendUrl.replace(/\/$/,"")+path,{
        ...options,
        signal:controller.signal,
        headers:{"Content-Type":"application/json",...(options.headers||{})}
      });
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.detail||data.error||"Request failed ("+response.status+")");
      return data;
    }finally{
      clearTimeout(timer);
    }
  }

  function setModeStatus(kind,title,detail){
    $("modeLed").className="agent-led"+(kind?" "+kind:"");
    $("modeTitle").textContent=title;
    $("modeDetail").textContent=detail;
  }

  async function loadData(showToast=false){
    if(state.mode==="demo"){
      state.data=cloneDemo();
      state.lastRefresh=new Date();
      setModeStatus("","Demo fabric","Simulated network estate");
      renderAll();
      if(showToast)toast("Demo refreshed","Representative configuration history loaded.");
      return;
    }

    setModeStatus("","Connecting…",state.backendUrl);
    try{
      state.data=await fetchJson("/api/bootstrap");
      state.lastRefresh=new Date();
      setModeStatus("live","Live backup engine",state.backendUrl.replace(/^https?:\/\//,""));
      renderAll();
      if(showToast)toast("Live data refreshed","Latest devices and backup history loaded.");
    }catch(error){
      setModeStatus("error","Backend unavailable",state.backendUrl.replace(/^https?:\/\//,""));
      toast("Could not reach backup engine",error.message,"error");
      if(!state.data){
        state.data=cloneDemo();
        renderAll();
      }
    }
  }

  function openPage(page){
    state.activePage=page;
    qsa("[data-page-panel]").forEach(p=>p.classList.toggle("active",p.dataset.pagePanel===page));
    qsa("[data-page]").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
    $("pageEyebrow").textContent=pageMeta[page][0];
    $("pageTitle").textContent=pageMeta[page][1];
    $("sidebar").classList.remove("open");

    if(page==="devices")renderDevices();
    if(page==="backups")renderBackups();
    if(page==="compare")renderCompareSelectors();
    if(page==="schedules")renderSchedules();
    if(page==="audit")renderAudit();
  }

  qsa("[data-page]").forEach(button=>button.addEventListener("click",()=>openPage(button.dataset.page)));
  qsa("[data-go]").forEach(button=>button.addEventListener("click",()=>openPage(button.dataset.go)));
  $("menuButton").addEventListener("click",()=> $("sidebar").classList.toggle("open"));

  function successfulBackups(){return (state.data?.backups||[]).filter(b=>b.status==="success")}
  function deviceBackups(deviceId){return (state.data?.backups||[]).filter(b=>b.device_id===deviceId).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))}
  function latestBackup(deviceId){return deviceBackups(deviceId)[0]||null}
  function derive(){
    const devices=state.data?.devices||[];
    const backups=state.data?.backups||[];
    const recent=backups.slice().sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,20);
    const successful=recent.filter(b=>b.status==="success");
    const successRate=recent.length?successful.length/recent.length*100:100;
    const scheduled=devices.filter(d=>Number(d.interval_minutes)>0);
    const changed=devices.filter(d=>latestBackup(d.id)?.changed);
    return {devices,backups,recent,successful,successRate,scheduled,changed};
  }

  function renderDashboard(){
    const d=derive();
    $("deviceCountBadge").textContent=d.devices.length;
    $("statDevices").textContent=d.devices.length;
    $("statBackups").textContent=d.backups.length;
    $("statChanged").textContent=d.changed.length;
    $("statSuccess").textContent=d.successRate.toFixed(0)+"%";
    $("statScheduled").textContent=(d.devices.length?d.scheduled.length/d.devices.length*100:0).toFixed(0)+"%";

    $("heroTerminal").textContent=[
      "[READY] Network Config Backup Manager",
      "[INFO ] "+d.devices.length+" devices registered",
      "[INFO ] "+d.scheduled.length+" scheduled for automatic backup",
      "[INFO ] "+d.backups.length+" snapshots retained",
      d.changed.length?"[WARN ] "+d.changed.length+" device(s) changed since previous snapshot":"[OK   ] No unreviewed configuration changes"
    ].join("\n");

    $("rackGrid").innerHTML=d.devices.map(device=>{
      const last=latestBackup(device.id);
      const stateClass=device.last_status==="failed"?"bad":last?.changed?"warn":"";
      const label=device.last_status==="failed"?"Backup failed":last?.changed?"Changed":"Protected";
      return '<div class="rack-unit" data-device="'+device.id+'">'
        +'<div class="rack-ports"></div>'
        +'<div><strong>'+esc(device.hostname)+'</strong><small>'+esc(device.ip+" · "+device.site)+'</small></div>'
        +'<span class="rack-state '+stateClass+'">'+label+'</span></div>';
    }).join("");

    const changed=(state.data.backups||[]).filter(b=>b.changed||b.status==="failed").sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,6);
    $("changeList").innerHTML=changed.length?changed.map(b=>{
      const failed=b.status==="failed";
      return '<div class="change-item" data-backup="'+b.id+'"><i class="'+(failed?"failed":"changed")+'"></i><div><strong>'+esc(b.device+" · "+(failed?"Backup failure":"Config changed"))+'</strong><small>'+esc(failed?(b.error||"Connection failed"):"Version "+b.version+" · "+b.source)+'</small></div><time>'+fmtTime(b.created_at)+'</time></div>';
    }).join(""):'<div class="empty">No recent changes or failures.</div>';

    $("activityList").innerHTML=d.recent.slice(0,6).map(b=>'<div class="activity-item" data-backup="'+b.id+'"><i></i><div><strong>'+esc(b.device+" · "+(b.status==="success"?"Backup completed":"Backup failed"))+'</strong><small>'+esc(b.status==="success"?"v"+b.version+" · "+fmtBytes(b.size):b.error||"Unknown error")+'</small></div><time>'+fmtTime(b.created_at)+'</time></div>').join("");

    const sites={};d.devices.forEach(x=>sites[x.site]=(sites[x.site]||0)+1);
    const entries=Object.entries(sites).sort((a,b)=>b[1]-a[1]);
    const max=Math.max(1,...entries.map(e=>e[1]));
    $("siteBars").innerHTML=entries.map(([site,count])=>'<div class="bar-row"><span>'+esc(site)+'</span><div class="bar-track"><div class="bar-fill" style="width:'+count/max*100+'%"></div></div><strong>'+count+'</strong></div>').join("");

    qsa("[data-device]",$("rackGrid")).forEach(node=>node.addEventListener("click",()=>openDevice(Number(node.dataset.device))));
    qsa("[data-backup]",$("changeList")).concat(qsa("[data-backup]",$("activityList"))).forEach(node=>node.addEventListener("click",()=>openBackup(Number(node.dataset.backup))));
  }

  function updateDeviceFilters(){
    const sites=[...new Set((state.data?.devices||[]).map(d=>d.site))].sort();
    const roles=[...new Set((state.data?.devices||[]).map(d=>d.role))].sort();
    const siteSel=$("deviceSiteFilter"),roleSel=$("deviceRoleFilter");
    const currentSite=siteSel.value,currentRole=roleSel.value;
    siteSel.innerHTML='<option value="all">All sites</option>'+sites.map(x=>'<option>'+esc(x)+'</option>').join("");
    roleSel.innerHTML='<option value="all">All roles</option>'+roles.map(x=>'<option>'+esc(x)+'</option>').join("");
    if(sites.includes(currentSite))siteSel.value=currentSite;
    if(roles.includes(currentRole))roleSel.value=currentRole;
  }

  function deviceMatches(device){
    const q=$("deviceSearch").value.trim().toLowerCase();
    const site=$("deviceSiteFilter").value;
    const role=$("deviceRoleFilter").value;
    const hay=[device.hostname,device.ip,device.role,device.site,device.platform_label,...(device.tags||[])].join(" ").toLowerCase();
    return (!q||hay.includes(q))&&(site==="all"||device.site===site)&&(role==="all"||device.role===role);
  }

  function renderDevices(){
    if(!state.data)return;
    updateDeviceFilters();
    const devices=(state.data.devices||[]).filter(deviceMatches);
    $("deviceRack").innerHTML=devices.length?devices.map(d=>{
      const last=latestBackup(d.id);
      return '<article class="device-card" data-id="'+d.id+'">'
        +'<div class="device-face"><span class="port-led"></span><span class="port-led"></span><span class="port-led"></span><span class="port-led"></span><b>'+esc(d.hostname)+'</b></div>'
        +'<h3>'+esc(d.hostname)+'</h3><p>'+esc(d.ip+" · "+d.platform_label)+'</p>'
        +'<div class="device-meta"><span>'+esc(d.role)+'</span><span>'+esc(d.site)+'</span><span>Every '+(d.interval_minutes?Math.round(d.interval_minutes/60)+"h":"manual")+'</span><span>Keep '+d.retention+'</span></div>'
        +'<div class="device-footer"><span>Last: '+fmtTime(d.last_backup_at)+'</span><strong class="rack-state '+(d.last_status==="failed"?"bad":last?.changed?"warn":"")+'">'+(d.last_status==="failed"?"Failed":last?.changed?"Changed":"OK")+'</strong></div>'
        +'</article>';
    }).join(""):'<div class="empty">No devices match the filters.</div>';
    qsa("[data-id]",$("deviceRack")).forEach(card=>card.addEventListener("click",()=>openDevice(Number(card.dataset.id))));
  }

  function renderBackups(){
    const deviceSel=$("backupDeviceFilter");
    const current=deviceSel.value;
    deviceSel.innerHTML='<option value="all">All devices</option>'+(state.data?.devices||[]).map(d=>'<option value="'+d.id+'">'+esc(d.hostname)+'</option>').join("");
    if([...deviceSel.options].some(o=>o.value===current))deviceSel.value=current;

    const q=$("backupSearch").value.trim().toLowerCase();
    const device=deviceSel.value;
    const change=$("backupChangedFilter").value;
    const rows=[...(state.data?.backups||[])].filter(b=>{
      const hay=[b.device,b.version,b.hash,b.status,b.source,b.error].join(" ").toLowerCase();
      return (!q||hay.includes(q))
        &&(device==="all"||String(b.device_id)===device)
        &&(change==="all"||(change==="changed"?b.changed:!b.changed));
    }).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));

    $("backupTableBody").innerHTML=rows.length?rows.map(b=>'<tr data-id="'+b.id+'">'
      +'<td><span class="version-code">v'+b.version+'</span></td>'
      +'<td>'+esc(b.device)+'</td><td>'+esc(b.source)+'</td>'
      +'<td><span class="status-chip '+esc(b.status)+'">'+esc(b.status)+'</span></td>'
      +'<td><span class="change-chip '+(b.changed?"changed":"unchanged")+'">'+(b.changed?"Changed":"Unchanged")+'</span></td>'
      +'<td><span class="hash-code">'+esc(b.hash)+'</span></td><td>'+fmtBytes(b.size)+'</td><td>'+fmtTime(b.created_at)+'</td></tr>').join("")
      :'<tr><td colspan="8" class="empty">No backup versions match the filters.</td></tr>';

    qsa("tr[data-id]",$("backupTableBody")).forEach(row=>row.addEventListener("click",()=>openBackup(Number(row.dataset.id))));
  }

  function renderCompareSelectors(){
    const deviceSel=$("compareDevice");
    const current=deviceSel.value;
    const eligible=(state.data?.devices||[]).filter(d=>deviceBackups(d.id).filter(b=>b.status==="success").length>=2);
    deviceSel.innerHTML=eligible.map(d=>'<option value="'+d.id+'">'+esc(d.hostname)+'</option>').join("");
    if(eligible.some(d=>String(d.id)===current))deviceSel.value=current;
    updateCompareVersions();
  }

  function updateCompareVersions(){
    const deviceId=Number($("compareDevice").value);
    const versions=deviceBackups(deviceId).filter(b=>b.status==="success");
    const base=$("compareBase"),target=$("compareTarget");
    base.innerHTML=versions.map(b=>'<option value="'+b.id+'">v'+b.version+' · '+new Date(b.created_at).toLocaleString()+'</option>').join("");
    target.innerHTML=versions.map(b=>'<option value="'+b.id+'">v'+b.version+' · '+new Date(b.created_at).toLocaleString()+'</option>').join("");
    if(versions.length>=2){base.value=String(versions[1].id);target.value=String(versions[0].id)}
  }

  function simpleDiff(baseText,targetText){
    const a=baseText.split("\n"),b=targetText.split("\n");
    const aSet=new Set(a),bSet=new Set(b);
    const removed=a.filter(x=>!bSet.has(x));
    const added=b.filter(x=>!aSet.has(x));
    return {added,removed,base:a,target:b};
  }

  function highlightConfig(lines,addedSet,removedSet,mode){
    return lines.map(line=>{
      const cls=mode==="base"&&removedSet.has(line)?"diff-remove":mode==="target"&&addedSet.has(line)?"diff-add":"diff-context";
      return '<span class="'+cls+'">'+esc(line)+'</span>';
    }).join("");
  }

  async function runCompare(){
    const baseId=Number($("compareBase").value),targetId=Number($("compareTarget").value);
    if(!baseId||!targetId||baseId===targetId){toast("Choose two versions","Base and target versions must be different.","error");return}

    let payload;
    if(state.mode==="live"){
      try{payload=await fetchJson("/api/compare?base_id="+baseId+"&target_id="+targetId)}
      catch(e){toast("Could not compare configs",e.message,"error");return}
    }else{
      const base=(state.data.backups||[]).find(b=>b.id===baseId),target=(state.data.backups||[]).find(b=>b.id===targetId);
      if(!base||!target)return;
      const d=simpleDiff(base.config||"",target.config||"");
      payload={base,target,added:d.added,removed:d.removed};
    }

    const base=payload.base,target=payload.target;
    const added=new Set(payload.added||[]),removed=new Set(payload.removed||[]);
    $("baseLabel").textContent=base.device+" · v"+base.version;
    $("targetLabel").textContent=target.device+" · v"+target.version;
    $("baseConfig").innerHTML=highlightConfig((base.config||"").split("\n"),added,removed,"base");
    $("targetConfig").innerHTML=highlightConfig((target.config||"").split("\n"),added,removed,"target");
    $("diffSummary").innerHTML='<span class="diff-pill added">+'+(payload.added||[]).length+' added</span><span class="diff-pill removed">-'+(payload.removed||[]).length+' removed</span><span class="diff-pill changed">'+((payload.added||[]).length+(payload.removed||[]).length)+' changed lines</span>';
  }

  function renderSchedules(){
    const devices=state.data?.devices||[];
    $("scheduleGrid").innerHTML=devices.map(d=>'<article class="schedule-card">'
      +'<p class="eyebrow">'+esc(d.site)+'</p><h3>'+esc(d.hostname)+'</h3><p>'+esc(d.role+" · "+d.ip)+'</p>'
      +'<div class="schedule-meta"><div><span>Interval</span><strong>'+(d.interval_minutes?d.interval_minutes+" min":"Manual")+'</strong></div><div><span>Retention</span><strong>'+d.retention+' versions</strong></div><div><span>Last backup</span><strong>'+fmtTime(d.last_backup_at)+'</strong></div><div><span>Status</span><strong class="rack-state '+(d.last_status==="failed"?"bad":"")+'">'+esc(d.last_status||"unknown")+'</strong></div></div>'
      +'<button class="btn secondary" data-schedule-device="'+d.id+'">Edit schedule</button></article>').join("");
    qsa("[data-schedule-device]").forEach(b=>b.addEventListener("click",()=>openDevice(Number(b.dataset.scheduleDevice))));
  }

  function renderAudit(){
    $("auditList").innerHTML=(state.data?.audit||[]).slice().sort((a,b)=>new Date(b.at)-new Date(a.at)).map(a=>'<div class="audit-item"><span class="audit-icon">LOG</span><div><strong>'+esc(a.action)+'</strong><small>'+esc(a.actor+" · "+a.detail)+'</small></div><time>'+fmtTime(a.at)+'</time></div>').join("");
  }

  async function openDevice(id){
    const device=(state.data?.devices||[]).find(d=>d.id===id);
    if(!device)return;
    state.selectedDevice=id;
    $("deviceDialogTitle").textContent=device.hostname;
    $("detailHostname").textContent=device.hostname;
    $("detailIp").textContent=device.ip;
    $("detailPlatform").textContent=device.platform_label;
    $("editHostname").value=device.hostname;
    $("editIp").value=device.ip;
    $("editRole").value=device.role;
    $("editSite").value=device.site;
    $("editPlatform").value=device.platform;
    $("editTags").value=(device.tags||[]).join(", ");
    $("editInterval").value=device.interval_minutes||0;
    $("editRetention").value=device.retention||10;
    $("editUsername").value=device.username||"";
    $("editPassword").value="";
    $("editSecret").value="";
    $("editPort").value=device.port||22;

    const history=deviceBackups(id).slice(0,6);
    $("deviceBackupHistory").innerHTML=history.length?history.map(b=>'<div class="mini-item" data-backup="'+b.id+'"><div><strong>v'+b.version+' · '+esc(b.status)+'</strong><small>'+esc(b.source)+(b.changed?" · changed":"")+'</small></div><time>'+fmtTime(b.created_at)+'</time></div>').join(""):'<div class="empty">No backups yet.</div>';
    $("deviceAuditHistory").innerHTML=(state.data.audit||[]).filter(a=>a.device_id===id).slice(0,6).map(a=>'<div class="mini-item"><div><strong>'+esc(a.action)+'</strong><small>'+esc(a.detail)+'</small></div><time>'+fmtTime(a.at)+'</time></div>').join("")||'<div class="empty">No audit history.</div>';
    qsa("[data-backup]",$("deviceBackupHistory")).forEach(n=>n.addEventListener("click",()=>openBackup(Number(n.dataset.backup))));
    $("deviceDialog").showModal();
  }

  async function saveDevice(){
    const id=state.selectedDevice;if(!id)return;
    const body={
      hostname:$("editHostname").value.trim(),
      ip:$("editIp").value.trim(),
      role:$("editRole").value.trim(),
      site:$("editSite").value.trim(),
      platform:$("editPlatform").value,
      tags:$("editTags").value.split(",").map(x=>x.trim()).filter(Boolean),
      interval_minutes:Number($("editInterval").value)||0,
      retention:Number($("editRetention").value)||10,
      username:$("editUsername").value.trim(),
      password:$("editPassword").value,
      secret:$("editSecret").value,
      port:Number($("editPort").value)||22
    };

    if(state.mode==="live"){
      try{await fetchJson("/api/devices/"+id,{method:"PUT",body:JSON.stringify(body)});$("deviceDialog").close();await loadData();toast("Device updated",body.hostname)}
      catch(e){toast("Could not update device",e.message,"error")}
      return;
    }

    const d=state.data.devices.find(x=>x.id===id);
    Object.assign(d,body,{platform_label:body.platform==="cisco_nxos"?"Cisco NX-OS":body.platform==="arista_eos"?"Arista EOS":"Cisco IOS / IOS XE"});
    addAudit("Jim Camus","Device updated",d.hostname+" inventory and schedule settings updated.",id);
    persistDemo();$("deviceDialog").close();renderAll();toast("Device updated",d.hostname+" saved in demo mode.");
  }

  function addAudit(actor,action,detail,deviceId=null){
    const next=Math.max(0,...(state.data.audit||[]).map(a=>a.id))+1;
    state.data.audit.unshift({id:next,at:new Date().toISOString(),actor,action,detail,device_id:deviceId});
  }

  async function backupDevice(id){
    const device=(state.data?.devices||[]).find(d=>d.id===id);
    if(!device)return;
    if(state.mode==="live"){
      toast("Backup started",device.hostname+" is being queried over SSH.");
      try{
        const result=await fetchJson("/api/devices/"+id+"/backup",{method:"POST",body:JSON.stringify({source:"running-config"})},{timeout:45000});
        await loadData();toast("Backup completed",result.device+" v"+result.version+(result.changed?" · change detected":""));
      }catch(e){await loadData();toast("Backup failed",e.message,"error")}
      return;
    }

    const existing=deviceBackups(id),latest=existing.find(b=>b.status==="success");
    const newId=Math.max(0,...state.data.backups.map(b=>b.id))+1;
    const version=Math.max(0,...existing.map(b=>b.version))+1;
    const config=latest?.config||"! simulated configuration\nhostname "+device.hostname+"\n";
    const changed=Math.random()<.25;
    const nextConfig=changed?config+"\n! demo change\nlogging host 192.168.99.20\n":config;
    const hash=(Math.random().toString(16).slice(2,14)).padEnd(12,"0");
    const backup={id:newId,device_id:id,device:device.hostname,version,source:"running-config",status:"success",changed,hash,size:nextConfig.length,created_at:new Date().toISOString(),config:nextConfig};
    state.data.backups.unshift(backup);device.last_backup_at=backup.created_at;device.last_status="success";
    addAudit("Backup Engine","Backup completed",device.hostname+" version "+version+" stored"+(changed?"; configuration change detected.":"."),id);
    persistDemo();renderAll();toast("Demo backup completed",device.hostname+" v"+version+(changed?" · change detected":""));
  }

  async function backupAll(){
    const devices=state.data?.devices||[];
    if(!devices.length)return;
    $("backupAllButton").disabled=true;
    try{
      if(state.mode==="live"){
        toast("Backup-all started",devices.length+" devices queued.");
        const result=await fetchJson("/api/backups/run-all",{method:"POST",body:"{}"},{timeout:120000});
        await loadData();toast("Backup-all finished",(result.success||0)+" succeeded · "+(result.failed||0)+" failed");
      }else{
        for(const d of devices)await backupDevice(d.id);
      }
    }finally{$("backupAllButton").disabled=false}
  }

  function openBackup(id){
    const backup=(state.data?.backups||[]).find(b=>b.id===id);if(!backup)return;
    state.selectedBackup=id;
    $("backupDialogTitle").textContent=backup.device+" · v"+backup.version;
    $("backupMeta").innerHTML=[
      backup.source,backup.status,backup.changed?"Changed":"Unchanged",backup.hash,fmtBytes(backup.size),new Date(backup.created_at).toLocaleString()
    ].map(v=>'<span>'+esc(v)+'</span>').join("");
    $("backupConfigViewer").textContent=backup.config||backup.error||"No configuration content stored.";
    $("downloadBackupButton").disabled=backup.status!=="success";
    $("backupDialog").showModal();
  }

  function downloadBackup(){
    const backup=(state.data?.backups||[]).find(b=>b.id===state.selectedBackup);if(!backup||backup.status!=="success")return;
    if(state.mode==="live"){
      window.open(state.backendUrl.replace(/\/$/,"")+"/api/backups/"+backup.id+"/download","_blank","noopener");
      return;
    }
    const blob=new Blob([backup.config||""],{type:"text/plain;charset=utf-8"}),url=URL.createObjectURL(blob),a=document.createElement("a");
    a.href=url;a.download=backup.device+"_v"+backup.version+".cfg";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  $("deviceSearch").addEventListener("input",renderDevices);
  $("deviceSiteFilter").addEventListener("change",renderDevices);
  $("deviceRoleFilter").addEventListener("change",renderDevices);
  $("backupSearch").addEventListener("input",renderBackups);
  $("backupDeviceFilter").addEventListener("change",renderBackups);
  $("backupChangedFilter").addEventListener("change",renderBackups);
  $("compareDevice").addEventListener("change",updateCompareVersions);
  $("runCompareButton").addEventListener("click",runCompare);
  $("refreshButton").addEventListener("click",()=>loadData(true));
  $("backupAllButton").addEventListener("click",backupAll);
  $("saveDeviceButton").addEventListener("click",saveDevice);
  $("backupDeviceButton").addEventListener("click",()=>{const id=state.selectedDevice;$("deviceDialog").close();backupDevice(id)});
  $("openCompareDeviceButton").addEventListener("click",()=>{const id=state.selectedDevice;$("deviceDialog").close();openPage("compare");$("compareDevice").value=String(id);updateCompareVersions()});
  $("downloadBackupButton").addEventListener("click",downloadBackup);

  $("addDeviceButton").addEventListener("click",()=>{$("addDeviceForm").reset();$("addDeviceDialog").showModal()});
  $("addDeviceForm").addEventListener("submit",async e=>{
    e.preventDefault();
    const body={
      hostname:$("newHostname").value.trim(),ip:$("newIp").value.trim(),role:$("newRole").value.trim(),site:$("newSite").value.trim(),
      platform:$("newPlatform").value,tags:$("newTags").value.split(",").map(x=>x.trim()).filter(Boolean),
      username:$("newUsername").value.trim(),password:$("newPassword").value,secret:"",port:22,interval_minutes:720,retention:15
    };
    if(state.mode==="live"){
      try{const d=await fetchJson("/api/devices",{method:"POST",body:JSON.stringify(body)});$("addDeviceDialog").close();await loadData();toast("Device enrolled",d.hostname)}
      catch(err){toast("Could not enroll device",err.message,"error")}
      return;
    }
    const id=Math.max(0,...state.data.devices.map(d=>d.id))+1;
    const d={id,...body,platform_label:body.platform==="cisco_nxos"?"Cisco NX-OS":body.platform==="arista_eos"?"Arista EOS":"Cisco IOS / IOS XE",last_backup_at:null,last_status:"never"};
    state.data.devices.push(d);addAudit("Jim Camus","Device enrolled",d.hostname+" added to the authorized device inventory.",id);persistDemo();$("addDeviceDialog").close();renderAll();toast("Device enrolled",d.hostname+" added to demo fabric.");
  });

  const conn=$("connectionDialog");
  $("connectionButton").addEventListener("click",()=>{qsa('input[name="mode"]').forEach(r=>r.checked=r.value===state.mode);$("backendUrlInput").value=state.backendUrl;conn.showModal()});
  $("saveConnectionButton").addEventListener("click",()=>{
    const mode=qsa('input[name="mode"]').find(r=>r.checked)?.value||"demo";
    const url=$("backendUrlInput").value.trim().replace(/\/$/,"");
    if(mode==="live"&&!/^https?:\/\//i.test(url)){toast("Invalid backend URL","Use a URL such as http://127.0.0.1:8800","error");return}
    state.mode=mode;state.backendUrl=url||"http://127.0.0.1:8800";
    localStorage.setItem("config_backup_mode",mode);localStorage.setItem("config_backup_backend_url",state.backendUrl);
    conn.close();state.data=null;loadData(true);
  });

  function renderAll(){
    if(!state.data)return;
    $("lastRefresh").textContent=(state.lastRefresh||new Date()).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"});
    renderDashboard();renderDevices();renderBackups();renderCompareSelectors();renderSchedules();renderAudit();
  }

  setInterval(()=>{if(state.mode==="live"&&document.visibilityState==="visible")loadData(false)},45000);
  loadData();
})();