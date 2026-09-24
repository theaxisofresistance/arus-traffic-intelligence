'use strict';
const $ = id => document.getElementById(id);
const state = {data:null, sensor:0, horizon:12, page:'ringkasan', listPage:0, request:0, pending:0, map:null, mapLayer:null, mapMarkers:new Map(), mapRevision:null, routeLayer:null, iotTimer:null};
const titles = {
  ringkasan:['Lalu lintas, lebih terbaca.','Pahami pergerakan hari ini. Lihat kemungkinan arus berikutnya.','Ringkasan'],
  prediksi:['Selangkah di depan arus.','Eksplorasi prediksi, bandingkan hasil, dan temukan polanya.','Prediksi arus'],
  peta:['Lihat arus dari sudut berbeda.','Jelajahi nilai dan posisi sensor pada jaringan operasional.','Peta sensor'],
  sensor:['Setiap sensor, satu cerita.','Telusuri pengamatan terakhir dari setiap titik dalam dataset.','Daftar sensor'],
  iot:['Sensor terhubung, data mengalir.','Terima dan pantau data POST dari perangkat IoT secara langsung.','IoT Live'],
  data:['Data yang tepat. Prediksi yang berarti.','Hubungkan dataset dan checkpoint hasil training Anda.','Model & data']
};
const number = (v,d=1) => v === null || v === undefined || !Number.isFinite(v) ? '—' : new Intl.NumberFormat('id-ID',{maximumFractionDigits:d,minimumFractionDigits:d}).format(v);
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const text = (id, value) => {$(id).textContent=value;};
const percentage = v => v === null || v === undefined ? '—' : `${number(v)}%`;
let toastTimer;
function toast(message){text('toast',message);$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4500);}
function fail(error){text('error-message',error.message || 'Tidak dapat terhubung ke server.');$('error-banner').hidden=false;window.scrollTo({top:0,behavior:'smooth'});}
function closeMenu(){$('sidebar').classList.remove('open');$('scrim').hidden=true;$('menu-button').setAttribute('aria-expanded','false');}
function setPage(page){
  if(!titles[page]) page='ringkasan';state.page=page;
  document.querySelectorAll('[data-panel]').forEach(el=>el.hidden=el.dataset.panel!==page);
  $('context-strip').hidden=page!=='sensor';
  document.querySelectorAll('.nav-item').forEach(el=>{el.classList.toggle('active',el.dataset.page===page);el.setAttribute('aria-current',el.dataset.page===page?'page':'false');});
  text('page-title',titles[page][0]);text('page-subtitle',titles[page][1]);text('breadcrumb-title',titles[page][2]);
  history.replaceState(null,'',`#${page}`);closeMenu();
  clearInterval(state.iotTimer);state.iotTimer=null;
  if(page==='iot'){loadIot();state.iotTimer=setInterval(()=>{if(state.page==='iot')loadIot(true);},5000);}
  if(state.data){renderCharts();if(page==='sensor')renderSensors();if(page==='peta')setTimeout(renderMap,0);}
}
async function api(url, options={}){
  const headers = {...options.headers};
  if(options.method && options.method!=='GET') headers['X-CSRF-Token']=document.querySelector('meta[name=csrf-token]').content;
  const response=await fetch(url,{...options,headers});
  let body;try{body=await response.json();}catch{throw new Error('Respons server tidak dapat dibaca. Coba lagi.');}
  if(!response.ok) throw new Error(body.error || 'Permintaan tidak berhasil.');
  return body;
}
async function load({reset=false}={}){
  const requestId=++state.request;
  $('error-banner').hidden=true;
  text('forecast-status','Memproses prediksi…');
  $('forecast-button').disabled=true;
  try{
    // After a mutation the server chooses its valid default sensor and horizon.
    const query=reset?'':`?sensor=${state.sensor}&horizon=${state.horizon}`;
    const data=await api(`/api/dashboard${query}`);
    if(requestId!==state.request)return;
    state.data=data;state.sensor=data.sensor;state.horizon=data.horizon;
    render();text('forecast-status','Prediksi siap');
    if(data.notice)toast(data.notice);
  }catch(error){if(requestId===state.request){fail(error);text('forecast-status','Prediksi gagal');}}
  finally{if(requestId===state.request)$('forecast-button').disabled=false;}
}
function option(value,label){const node=document.createElement('option');node.value=value;node.textContent=label;return node;}
function render(){
  const d=state.data,s=d.summary;
  text('source-tag',d.provisioned?'Sumber operasional':'Dataset unggahan');
  text('engine-label',d.engine);text('dataset-label',`${d.nodes} sensor · interval ${d.interval} menit · ${number(d.steps,0)} sampel`);
  text('nav-count',d.nodes);text('stat-flow',number(s.flow));text('stat-speed',number(s.speed));
  text('speed-unit',d.speed_unit==='raw'?'skala asli':d.speed_unit);
  text('stat-occ',number(d.occupancy_unit==='fraction'&&s.occupancy!==null?s.occupancy*100:s.occupancy));
  text('occ-unit',d.occupancy_unit==='raw'?'skala asli':'%');text('stat-nodes',s.valid_nodes);text('node-total',`/ ${d.nodes}`);
  text('flow-change',s.change===null?'—':`${s.change>0?'+':''}${number(s.change)}%`);
  text('change-label',`vs ${Math.min(12,d.steps-1)*d.interval} menit sebelumnya`);
  text('forecast-span',`+${d.horizon*d.interval} menit`);
  const overviewSensor=$('overview-sensor');overviewSensor.replaceChildren(...d.sensors.map(row=>option(row.id,row.name)));overviewSensor.value=state.sensor;
  const predictionSensor=$('prediction-sensor');predictionSensor.replaceChildren(...d.sensors.map(row=>option(row.id,`${row.name} · ${row.map_location.road}`)));predictionSensor.value=state.sensor;
  const horizon=$('horizon-select');horizon.replaceChildren(...Array.from({length:d.max_horizon},(_,i)=>option(i+1,`${(i+1)*d.interval} menit · ${i+1} langkah`)));horizon.value=state.horizon;
  text('insight-mae',number(d.evaluation.model.mae,2));
  text('insight-copy',d.provisioned?'Evaluasi historis pada sumber operasional aktif.':'Evaluasi historis membantu membandingkan prediksi dan baseline.');
  text('eval-mae',number(d.evaluation.model.mae,2));text('eval-rmse',number(d.evaluation.model.rmse,2));text('eval-wape',percentage(d.evaluation.model.wape));
  text('baseline-mae',number(d.evaluation.persistence.mae,2));text('eval-skill',percentage(d.evaluation.skill));text('backtest-count',`${d.evaluation.origins} origin`);
  $('export-link').href=`/api/forecast.csv?sensor=${state.sensor}&horizon=${state.horizon}`;
  const selected=d.sensors[state.sensor];text('prediction-road',selected.map_location.road);
  text('forecast-table-label',`Sensor ${String(state.sensor).padStart(3,'0')} · ${selected.map_location.road} · skala flow asli`);
  $('forecast-table').innerHTML=d.forecast.map((row,i)=>`<tr><td>${String(i+1).padStart(2,'0')}</td><td>+${row.minute} menit</td><td>${number(row.value,2)}</td></tr>`).join('');
  $('overview-table').innerHTML=d.sensors.slice(0,5).map(row=>`<tr><td>${sensorName(row)}</td><td>${number(row.flow)}</td><td>${sparkline(row.spark)}</td><td>${number(row.prediction)}</td><td>${status(row)}</td></tr>`).join('');
  $('sensor-mosaic').innerHTML=d.sensors.slice(0,12).map(row=>`<button class="mosaic-node ${row.id===state.sensor?'selected':''} ${row.valid?'':'incomplete'}" data-select-sensor="${row.id}" aria-label="Pilih Sensor ${row.id}" aria-pressed="${row.id===state.sensor}"><strong>${String(row.id).padStart(3,'0')}</strong><span>${number(row.flow,0)}</span></button>`).join('');
  text('active-file',d.filename);text('active-model-tag',d.has_model?`STGNN${d.model_validation?' · validation':''}`:'Baseline');
  text('config-nodes',number(d.nodes,0));text('config-steps',number(d.steps,0));text('config-input',`${d.input_steps*d.interval} menit`);text('config-horizon',`${d.max_horizon*d.interval} menit`);
  $('remove-model').hidden=!d.has_model;
  renderSensors();renderRouteRecommendations();renderCharts();if(state.page==='peta')renderMap();
}
function sensorName(row){return `<span class="sensor-cell"><span class="sensor-symbol">${icon('sensor')}</span>${row.name}</span>`;}
function status(row){return `<span class="data-state"><i class="dot ${row.valid?'green':'amber'}"></i>${row.valid?'Lengkap':'Tidak lengkap'}</span>`;}
function pathFor(points,x,y){let started=false;return points.map(p=>{if(p.value===null || !Number.isFinite(p.value)){started=false;return '';}const action=started?'L':'M';started=true;return `${action}${x(p.minute).toFixed(2)},${y(p.value).toFixed(2)}`;}).join(' ');}
function sparkline(values){
  const finite=values.filter(v=>v!==null);if(!finite.length)return '—';
  const low=Math.min(...finite),high=Math.max(...finite);const points=values.map((value,minute)=>({value,minute}));
  return `<svg class="spark" viewBox="0 0 76 24" aria-hidden="true"><path fill="none" d="${pathFor(points,i=>2+i*72/Math.max(1,values.length-1),v=>21-(v-low)*18/Math.max(1,high-low))}"/></svg>`;
}
function chart(id){
  const holder=$(id),d=state.data;
  if(!d||holder.closest('[hidden]'))return;
  const width=Math.max(300,holder.clientWidth-30),height=id==='prediction-chart'?280:226;
  const left=44,right=17,top=27,bottom=37;
  const all=[...d.history,...d.forecast],finite=all.map(p=>p.value).filter(v=>v!==null&&Number.isFinite(v));
  if(!finite.length){holder.textContent='Tidak ada data valid untuk grafik.';return;}
  const min=Math.min(0,...finite),max=Math.max(...finite,1)*1.17;
  const minTime=d.history[0].minute,maxTime=d.forecast[d.forecast.length-1].minute;
  const x=v=>left+(v-minTime)/(maxTime-minTime)*(width-left-right);
  const y=v=>top+(max-v)/(max-min)*(height-top-bottom);
  const histPath=pathFor(d.history,x,y);
  const last=d.history[d.history.length-1];
  const forecast=last.value===null?d.forecast:[last,...d.forecast];
  let grid='';for(let i=0;i<=4;i++){const value=min+(max-min)*i/4;grid+=`<line class="grid-line" x1="${left}" y1="${y(value)}" x2="${width-right}" y2="${y(value)}"/><text x="${left-9}" y="${y(value)+3}" text-anchor="end">${number(value,0)}</text>`;}
  const ticks=[minTime,Math.round(minTime*.5),0,maxTime];
  let labels=ticks.map(v=>`<text x="${x(v)}" y="${height-12}" text-anchor="middle">${v>0?'+':''}${v===0?'0':v} m</text>`).join('');
  const circles=d.forecast.map(p=>`<circle cx="${x(p.minute)}" cy="${y(p.value)}" r="3" fill="#a3b376" stroke="white" stroke-width="1"><title>+${p.minute} menit: ${number(p.value,2)}</title></circle>`).join('');
  holder.innerHTML=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Grafik historis dan prediksi flow Sensor ${state.sensor}. Tabel angka tersedia pada halaman Prediksi."><defs><linearGradient id="fill-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#65b095" stop-opacity=".17"/><stop offset="100%" stop-color="#65b095" stop-opacity="0"/></linearGradient></defs><rect class="forecast-band" x="${x(0)}" y="${top-10}" width="${width-right-x(0)}" height="${height-top-bottom+10}" rx="4"/>${grid}<line class="boundary" x1="${x(0)}" x2="${x(0)}" y1="${top-10}" y2="${height-bottom}"/><text x="${x(0)+8}" y="${top-15}" font-size="8">PREDIKSI</text><path class="line-history" d="${histPath}"/><path class="line-forecast" d="${pathFor(forecast,x,y)}"/>${circles}${labels}<text x="${left}" y="12">Flow</text></svg>`;
}
function renderCharts(){chart('overview-chart');chart('prediction-chart');}
function renderSensors(){
  if(!state.data)return;
  const d=state.data,term=$('sensor-search').value.trim().toLowerCase();
  const rows=d.sensors.filter(r=>r.name.toLowerCase().includes(term)||String(r.id)===term);
  const count=12,lastPage=Math.max(0,Math.ceil(rows.length/count)-1);state.listPage=Math.min(state.listPage,lastPage);
  const start=state.listPage*count,visible=rows.slice(start,start+count);
  $('sensor-table').innerHTML=visible.length?visible.map(r=>`<tr><td>${sensorName(r)}</td><td>${number(r.flow)}</td><td>${number(r.speed)} ${d.speed_unit==='raw'?'':d.speed_unit}</td><td>${number(d.occupancy_unit==='fraction'&&r.occupancy!==null?r.occupancy*100:r.occupancy)}${d.occupancy_unit==='raw'?'':'%'}</td><td>${number(r.prediction)}</td><td>${number(r.mae,2)}</td><td>${status(r)}</td><td><button class="text-button" data-open-sensor="${r.id}">Lihat ${icon('arrow')}</button></td></tr>`).join(''):'<tr><td colspan="8" class="empty-row">Sensor tidak ditemukan. Coba indeks atau nama lain.</td></tr>';
  text('pagination-label',rows.length?`${start+1}–${Math.min(start+count,rows.length)} dari ${rows.length} sensor`:'0 sensor');
  $('previous-page').disabled=state.listPage===0;$('next-page').disabled=state.listPage>=lastPage;
}
function iotDate(value){
  if(!value)return '—';
  const date=new Date(value);return Number.isNaN(date.getTime())?value:new Intl.DateTimeFormat('id-ID',{dateStyle:'short',timeStyle:'medium'}).format(date);
}
async function loadIot(silent=false){
  try{
    const data=await api('/api/iot/readings?limit=50');
    text('iot-total',data.total);text('iot-devices',data.latest.length);
    text('iot-last',data.readings.length?iotDate(data.readings[0].received_at):'Belum ada data');
    const device=$('iot-device'),selected=device.value;
    device.replaceChildren(...(data.devices.length?data.devices.map(row=>option(row.device_id,`${row.device_id} · ${row.pending} baru`)):[option('','Belum ada perangkat')]));
    if(selected&&data.devices.some(row=>row.device_id===selected))device.value=selected;
    const current=data.devices.find(row=>row.device_id===device.value);
    $('iot-append').disabled=!current||current.pending===0;
    $('iot-table').innerHTML=data.readings.length?data.readings.map(row=>`<tr><td>${iotDate(row.timestamp)}</td><td><span class="sensor-cell"><span class="sensor-symbol">${icon('sensor')}</span>${row.device_id}</span></td><td>${number(row.flow,2)}</td><td>${number(row.occupancy,2)}</td><td>${number(row.speed,2)}</td><td>${row.latitude===undefined?'—':`${number(row.latitude,6)}, ${number(row.longitude,6)}`}</td><td>${iotDate(row.received_at)}</td></tr>`).join(''):'<tr><td colspan="7" class="empty-row">Belum ada data sensor.</td></tr>';
  }catch(error){if(!silent)fail(error);}
}
function flowThresholds(rows){
  const values=rows.map(row=>row.flow).filter(Number.isFinite).sort((a,b)=>a-b);
  if(!values.length)return [0,0];
  return [values[Math.floor((values.length-1)/3)],values[Math.floor((values.length-1)*2/3)]];
}
function markerColor(row,thresholds){
  if(!row.valid)return '#d99a55';
  if(row.flow<=thresholds[0])return '#6ca98c';
  if(row.flow<=thresholds[1])return '#d2a84d';
  return '#c66757';
}
function renderRouteRecommendations(){
  if(!state.data)return;
  const routes=state.data.route_recommendations||[];
  const start=$('route-start'),end=$('route-end'),previousStart=start.value,previousEnd=end.value;
  const choices=state.data.sensors.map(row=>option(row.id,`${row.name} · ${row.map_location.road}`));
  start.replaceChildren(...choices);end.replaceChildren(...state.data.sensors.map(row=>option(row.id,`${row.name} · ${row.map_location.road}`)));
  start.value=previousStart&&state.data.sensors[Number(previousStart)]?previousStart:'0';
  end.value=previousEnd&&state.data.sensors[Number(previousEnd)]?previousEnd:String(Math.max(0,state.data.sensors.length-1));
  $('route-recommendations').innerHTML=routes.length?routes.map((route,index)=>{
    const occupancy=state.data.occupancy_unit==='fraction'&&route.occupancy!==null?route.occupancy*100:route.occupancy;
    return `<button class="route-option ${index===0?'recommended':''}" data-route-road="${route.road}"><span class="route-rank">${index+1}</span><span class="route-copy"><strong>${route.road}</strong><small>${route.status} · ${route.valid_sensors}/${route.sensors} sensor valid</small></span><span class="route-values"><strong>${number(route.score,1)}</strong><small>skor · ${number(route.speed)}${state.data.speed_unit==='raw'?'':` ${state.data.speed_unit}`} · occ ${number(occupancy)}${state.data.occupancy_unit==='raw'?'':'%'}</small></span>${icon('arrow')}</button>`;
  }).join(''):'<p class="empty-row">Belum ada data yang cukup untuk rekomendasi.</p>';
}
function geoDistance(a,b){
  const rad=Math.PI/180,lat1=a.map_location.latitude*rad,lat2=b.map_location.latitude*rad;
  const dLat=lat2-lat1,dLon=(b.map_location.longitude-a.map_location.longitude)*rad;
  const value=Math.sin(dLat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 6371*2*Math.atan2(Math.sqrt(value),Math.sqrt(1-value));
}
function recommendedPath(startId,endId){
  const sensors=state.data.sensors,adj=sensors.map(()=>[]),scores=new Map((state.data.route_recommendations||[]).map(row=>[row.road,row.score]));
  const connect=(a,b)=>{
    if(adj[a].some(edge=>edge.to===b))return;
    const pressure=((scores.get(sensors[a].map_location.road)??50)+(scores.get(sensors[b].map_location.road)??50))/200;
    const distance=geoDistance(sensors[a],sensors[b]),weight=distance*(1+pressure);
    adj[a].push({to:b,weight,distance});adj[b].push({to:a,weight,distance});
  };
  const roads=new Map();sensors.forEach(row=>{if(!roads.has(row.map_location.road))roads.set(row.map_location.road,[]);roads.get(row.map_location.road).push(row.id);});
  roads.forEach(ids=>ids.sort((a,b)=>a-b).forEach((id,index)=>{if(index)connect(ids[index-1],id);}));
  sensors.forEach((row,id)=>sensors.filter(other=>other.id!==id).map(other=>({id:other.id,distance:geoDistance(row,other)})).sort((a,b)=>a.distance-b.distance).slice(0,3).forEach(item=>connect(id,item.id)));
  const distance=Array(sensors.length).fill(Infinity),previous=Array(sensors.length).fill(null),visited=new Set();distance[startId]=0;
  while(visited.size<sensors.length){
    let current=-1,best=Infinity;distance.forEach((value,id)=>{if(!visited.has(id)&&value<best){best=value;current=id;}});
    if(current<0||current===endId)break;visited.add(current);
    adj[current].forEach(edge=>{const candidate=distance[current]+edge.weight;if(candidate<distance[edge.to]){distance[edge.to]=candidate;previous[edge.to]=current;}});
  }
  if(!Number.isFinite(distance[endId]))return null;
  const ids=[];for(let current=endId;current!==null;current=previous[current])ids.unshift(current);
  return ids;
}
function drawRecommendedRoute(){
  if(!state.data||!window.L)return;
  const startId=Number($('route-start').value),endId=Number($('route-end').value);
  if(startId===endId){fail(new Error('Pilih titik asal dan tujuan yang berbeda.'));return;}
  const ids=recommendedPath(startId,endId);if(!ids||ids.length<2){fail(new Error('Jalur antartitik tidak ditemukan.'));return;}
  const rows=ids.map(id=>state.data.sensors[id]),points=rows.map(row=>[row.map_location.latitude,row.map_location.longitude]);
  if(state.routeLayer)state.routeLayer.remove();
  state.routeLayer=L.polyline(points,{color:'#315f50',weight:5,opacity:.88,dashArray:'10 7'}).addTo(state.map);
  state.map.fitBounds(state.routeLayer.getBounds(),{padding:[45,45],maxZoom:13});
  const distance=rows.slice(1).reduce((total,row,index)=>total+geoDistance(rows[index],row),0);
  const corridors=[...new Set(rows.map(row=>row.map_location.road))];
  $('route-result').hidden=false;
  $('route-result').innerHTML=`<span class="route-result-icon">${icon('map')}</span><div><span>RUTE DIREKOMENDASIKAN</span><strong>${rows[0].name} → ${rows[rows.length-1].name}</strong><small>${number(distance,2)} km · ${ids.length} titik · ${corridors.join(' → ')}</small></div>`;
}
function focusRoute(road){
  if(!state.map||!state.data)return;
  const rows=state.data.sensors.filter(row=>row.map_location.road===road);
  const points=rows.map(row=>[row.map_location.latitude,row.map_location.longitude]);
  if(points.length>1)state.map.fitBounds(points,{padding:[45,45],maxZoom:13});
  else if(points.length===1)state.map.setView(points[0],13);
  if(rows.length)updateMapDetails(rows[0].id);
}
function updateMapDetails(sensor){
  const d=state.data,row=d?.sensors.find(item=>item.id===sensor);
  if(!row)return;
  state.sensor=row.id;
  text('map-sensor-name',row.name);text('map-road',row.map_location.road);text('map-flow',number(row.flow));
  text('map-speed',`${number(row.speed)}${d.speed_unit==='raw'?'':` ${d.speed_unit}`}`);
  const occupancy=d.occupancy_unit==='fraction'&&row.occupancy!==null?row.occupancy*100:row.occupancy;
  text('map-occupancy',`${number(occupancy)}${d.occupancy_unit==='raw'?'':'%'}`);
  text('map-prediction',number(row.prediction));
  $('map-open-prediction').dataset.openSensor=String(row.id);
  const thresholds=flowThresholds(d.sensors);
  state.mapMarkers.forEach((marker,id)=>marker.setStyle({radius:id===row.id?9:6,weight:id===row.id?4:2,color:id===row.id?'#173f35':'#ffffff',fillColor:markerColor(d.sensors[id],thresholds),fillOpacity:.9}));
}
function renderMap(){
  if(!state.data||state.page!=='peta')return;
  const holder=$('sensor-map');
  if(!window.L){holder.textContent='Library peta tidak dapat dimuat.';return;}
  if(!state.map){
    state.map=L.map(holder,{zoomControl:true,minZoom:8,maxZoom:16}).setView(state.data.map_metadata.center,10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(state.map);
    state.mapLayer=L.layerGroup().addTo(state.map);
  }
  state.map.invalidateSize();
  if(state.mapRevision!==state.data.revision){
    if(state.routeLayer){state.routeLayer.remove();state.routeLayer=null;$('route-result').hidden=true;}
    state.mapLayer.clearLayers();state.mapMarkers.clear();
    const thresholds=flowThresholds(state.data.sensors),bounds=[];
    state.data.sensors.forEach(row=>{
      const location=row.map_location,latlng=[location.latitude,location.longitude];bounds.push(latlng);
      const marker=L.circleMarker(latlng,{radius:6,weight:2,color:'#fff',fillColor:markerColor(row,thresholds),fillOpacity:.9});
      marker.bindTooltip(`${row.name} · ${location.road} · Flow ${number(row.flow)}`,{direction:'top'});
      marker.on('click',()=>updateMapDetails(row.id));marker.addTo(state.mapLayer);state.mapMarkers.set(row.id,marker);
    });
    if(bounds.length)state.map.fitBounds(bounds,{padding:[28,28],maxZoom:11});
    state.mapRevision=state.data.revision;
  }
  text('map-notice',state.data.map_metadata.notice);updateMapDetails(state.sensor);
}
async function mutate(url,options,button){
  if(state.pending)return;
  state.pending++;button.disabled=true;
  try{const result=await api(url,options);await load({reset:true});toast(result.message);}
  catch(error){fail(error);}
  finally{state.pending--;button.disabled=false;}
}
document.addEventListener('click',async event=>{
  const link=event.target.closest('[data-page]');if(link){setPage(link.dataset.page);window.scrollTo({top:0,behavior:'smooth'});return;}
  const route=event.target.closest('[data-route-road]');if(route){focusRoute(route.dataset.routeRoad);return;}
  const select=event.target.closest('[data-select-sensor],[data-open-sensor]');
  if(select){state.sensor=Number(select.dataset.selectSensor??select.dataset.openSensor);if(select.dataset.openSensor!==undefined)setPage('prediksi');await load();}
});
$('overview-sensor').addEventListener('change',event=>{state.sensor=Number(event.target.value);load();});
$('forecast-button').addEventListener('click',()=>{state.sensor=Number($('prediction-sensor').value);state.horizon=Number($('horizon-select').value);load();});
$('retry-button').addEventListener('click',()=>load({reset:true}));
$('sensor-search').addEventListener('input',()=>{state.listPage=0;renderSensors();});
$('previous-page').addEventListener('click',()=>{state.listPage--;renderSensors();});
$('next-page').addEventListener('click',()=>{state.listPage++;renderSensors();});
$('iot-refresh').addEventListener('click',()=>loadIot());
$('iot-clear').addEventListener('click',()=>$('iot-clear-dialog').showModal());
$('cancel-iot-clear').addEventListener('click',()=>$('iot-clear-dialog').close());
$('confirm-iot-clear').addEventListener('click',async()=>{
  $('iot-clear-dialog').close();
  const button=$('iot-clear');
  if(state.pending)return;
  state.pending++;button.disabled=true;
  try{const result=await api('/api/iot/storage',{method:'DELETE'});toast(result.message);await loadIot();}
  catch(error){fail(error);}
  finally{state.pending--;button.disabled=false;}
});
$('iot-device').addEventListener('change',()=>loadIot(true));
$('iot-append').addEventListener('click',async()=>{
  if(state.pending)return;
  const button=$('iot-append'),deviceId=$('iot-device').value;if(!deviceId)return;
  state.pending++;button.disabled=true;
  try{
    const result=await api('/api/iot/append',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({device_id:deviceId})});
    toast(result.message);await Promise.all([load({reset:true}),loadIot()]);
  }catch(error){fail(error);}
  finally{state.pending--;await loadIot(true);}
});
$('find-route').addEventListener('click',drawRecommendedRoute);
$('menu-button').addEventListener('click',()=>{const open=!$('sidebar').classList.contains('open');$('sidebar').classList.toggle('open',open);$('scrim').hidden=!open;$('menu-button').setAttribute('aria-expanded',String(open));});
$('scrim').addEventListener('click',closeMenu);
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeMenu();});
for(const kind of ['data','model']){
  $(`${kind}-file`).addEventListener('change',event=>text(`${kind}-filename`,event.target.files[0]?.name||'Belum ada berkas dipilih'));
  $(`${kind}-form`).addEventListener('submit',event=>{event.preventDefault();const form=event.currentTarget;const file=$(`${kind}-file`).files[0];if(!file)return;if(file.size>80*1024*1024){fail(new Error('Maksimum ukuran unggahan 80 MB.'));return;}mutate(`/api/${kind}`,{method:'POST',body:new FormData(form)},form.querySelector('button[type=submit]'));});
}
$('remove-model').addEventListener('click',()=>mutate('/api/model',{method:'DELETE'},$('remove-model')));
$('reset-button').addEventListener('click',()=>$('reset-dialog').showModal());
$('cancel-reset').addEventListener('click',()=>$('reset-dialog').close());
$('confirm-reset').addEventListener('click',()=>{$('reset-dialog').close();mutate('/api/reset',{method:'POST'},$('reset-button'));});
let resizeTimer;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{renderCharts();if(state.map)state.map.invalidateSize();},120);});
window.addEventListener('hashchange',()=>setPage(location.hash.slice(1)));
setPage(location.hash.slice(1)||'ringkasan');load({reset:true});
