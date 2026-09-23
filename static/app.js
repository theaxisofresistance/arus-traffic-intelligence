'use strict';
const $ = id => document.getElementById(id);
const state = {data:null, sensor:0, horizon:12, page:'ringkasan', listPage:0, request:0, pending:0, map:null, mapLayer:null, mapMarkers:new Map(), mapRevision:null};
const titles = {
  ringkasan:['Lalu lintas, lebih terbaca.','Pahami pergerakan hari ini. Lihat kemungkinan arus berikutnya.','Ringkasan'],
  prediksi:['Selangkah di depan arus.','Eksplorasi prediksi, bandingkan hasil, dan temukan polanya.','Prediksi arus'],
  peta:['Lihat arus dari sudut berbeda.','Jelajahi nilai sensor pada posisi ilustratif yang dibuat khusus untuk visualisasi.','Peta sensor'],
  sensor:['Setiap sensor, satu cerita.','Telusuri pengamatan terakhir dari setiap titik dalam dataset.','Daftar sensor'],
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
  document.querySelectorAll('.nav-item').forEach(el=>{el.classList.toggle('active',el.dataset.page===page);el.setAttribute('aria-current',el.dataset.page===page?'page':'false');});
  text('page-title',titles[page][0]);text('page-subtitle',titles[page][1]);text('breadcrumb-title',titles[page][2]);
  history.replaceState(null,'',`#${page}`);closeMenu();
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
  text('source-tag',d.synthetic?'Demo sintetis':'Dataset unggahan');
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
  text('insight-copy',d.synthetic?'Evaluasi ini berasal dari data atau model sintetis. Hubungkan data asli untuk analisis Anda.':'Evaluasi historis membantu membandingkan prediksi dan baseline. Periode test belum terverifikasi.');
  text('eval-mae',number(d.evaluation.model.mae,2));text('eval-rmse',number(d.evaluation.model.rmse,2));text('eval-wape',percentage(d.evaluation.model.wape));
  text('baseline-mae',number(d.evaluation.persistence.mae,2));text('eval-skill',percentage(d.evaluation.skill));text('backtest-count',`${d.evaluation.origins} origin`);
  $('export-link').href=`/api/forecast.csv?sensor=${state.sensor}&horizon=${state.horizon}`;
  const selected=d.sensors[state.sensor];text('prediction-road',selected.map_location.road);
  text('forecast-table-label',`Sensor ${String(state.sensor).padStart(3,'0')} · ${selected.map_location.road} · skala flow asli`);
  $('forecast-table').innerHTML=d.forecast.map((row,i)=>`<tr><td>${String(i+1).padStart(2,'0')}</td><td>+${row.minute} menit</td><td>${number(row.value,2)}</td></tr>`).join('');
  $('overview-table').innerHTML=d.sensors.slice(0,5).map(row=>`<tr><td>${sensorName(row)}</td><td>${number(row.flow)}</td><td>${sparkline(row.spark)}</td><td>${number(row.prediction)}</td><td>${status(row)}</td></tr>`).join('');
  $('sensor-mosaic').innerHTML=d.sensors.slice(0,12).map(row=>`<button class="mosaic-node ${row.id===state.sensor?'selected':''} ${row.valid?'':'incomplete'}" data-select-sensor="${row.id}" aria-label="Pilih Sensor ${row.id}" aria-pressed="${row.id===state.sensor}"><strong>${String(row.id).padStart(3,'0')}</strong><span>${number(row.flow,0)}</span></button>`).join('');
  text('active-file',d.filename);text('active-model-tag',d.has_model?`STGNN${d.model_demo?' · model demo':''}`:'Baseline');
  text('config-nodes',number(d.nodes,0));text('config-steps',number(d.steps,0));text('config-input',`${d.input_steps*d.interval} menit`);text('config-horizon',`${d.max_horizon*d.interval} menit`);
  $('remove-model').hidden=!d.has_model;
  renderSensors();renderCharts();if(state.page==='peta')renderMap();
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
  const select=event.target.closest('[data-select-sensor],[data-open-sensor]');
  if(select){state.sensor=Number(select.dataset.selectSensor??select.dataset.openSensor);if(select.dataset.openSensor!==undefined)setPage('prediksi');await load();}
});
$('overview-sensor').addEventListener('change',event=>{state.sensor=Number(event.target.value);load();});
$('forecast-button').addEventListener('click',()=>{state.sensor=Number($('prediction-sensor').value);state.horizon=Number($('horizon-select').value);load();});
$('retry-button').addEventListener('click',()=>load({reset:true}));
$('sensor-search').addEventListener('input',()=>{state.listPage=0;renderSensors();});
$('previous-page').addEventListener('click',()=>{state.listPage--;renderSensors();});
$('next-page').addEventListener('click',()=>{state.listPage++;renderSensors();});
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
