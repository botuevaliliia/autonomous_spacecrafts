const $ = id => document.getElementById(id);
let state = null, prediction = null, playing = false, busy = false;
let zoom = 1, stopAt = null, previewTimer, previewGeneration = 0;
let lastTick = performance.now();
const canvas = $('map'), ctx = canvas.getContext('2d');
let width = 900, height = 800, scale = 1, origin = [0, 0];
const money = value => Number(value).toLocaleString('en-US', {maximumFractionDigits: 1});
const magnitude = () => Number($('magnitude-number').value);
const angle = () => Number($('angle').value);
const clock = seconds => {
  const n = Math.floor(seconds);
  return [Math.floor(n/3600), Math.floor(n/60)%60, n%60].map(x => String(x).padStart(2,'0')).join(':');
};

async function api(path, body) {
  const response = await fetch(`/game/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(typeof error.detail === 'string' ? error.detail : `Request failed (${response.status})`);
  }
  $('connection').textContent = 'Flight connected';
  return response.json();
}
function feedback(message, error = false) {
  $('feedback').textContent = message;
  $('feedback').classList.toggle('error', error);
}
function pause(refresh = true) {
  playing = false;
  stopAt = null;
  $('play').innerHTML = '▶ <span>Play</span>';
  $('play').setAttribute('aria-label', 'Play simulation');
  if (state?.status === 'FLYING') $('flight-status').textContent = 'PAUSED';
  if (refresh && state?.status === 'FLYING') schedulePreview();
}
function controls() {
  const ended = !state || state.status !== 'FLYING';
  for (const name of ['play','step','burn','coast']) $(name).disabled = busy || ended;
  $('burn').disabled ||= magnitude() <= 0 || magnitude() > (state?.remaining_dv ?? 0);
  $('coast').disabled ||= !state?.burns.length;
  $('reset').disabled = busy;
  $('retry').disabled = busy;
}
function update(next) {
  state = next;
  $('clock').textContent = `T+ ${clock(state.time)}`;
  $('budget').textContent = money(state.remaining_dv);
  $('budget-bar').value = state.remaining_dv;
  $('distance').textContent = `${money(state.distance_km)} km`;
  $('relative-speed').textContent = `${money(state.relative_speed_m_s)} m/s`;
  const near = state.distance_km <= state.capture_distance_km;
  const matched = state.relative_speed_m_s <= state.capture_speed_m_s;
  $('distance-check').classList.toggle('met', near);
  $('speed-check').classList.toggle('met', matched);
  $('distance-goal').textContent = `${near ? '✓ Close enough' : '○ Need'} ≤${state.capture_distance_km} km`;
  $('speed-goal').textContent = `${matched ? '✓ Matched' : '○ Need'} ≤${state.capture_speed_m_s} m/s`;
  $('altitude').textContent = `${money(state.ship.altitude)} km`;
  $('velocity').textContent = `${state.ship.speed.toFixed(3)} km/s`;
  $('engine').textContent = `${state.physics_engine === 'basilisk' ? 'BASILISK' : 'NEWTONIAN RK4'} · MARS GRAVITY`;
  $('flight-status').textContent = state.status === 'FLYING' ? (playing ? 'IN FLIGHT' : 'PAUSED') : state.status;
  $('burn-count').textContent = `${state.burns.length} maneuver${state.burns.length === 1 ? '' : 's'}`;
  $('log').replaceChildren();
  const log = state.burns.length ? state.burns.map(b => `T+${clock(b.time)} · ${b.magnitude_m_s.toFixed(1)} m/s · ${b.angle_deg}°`) : ['No burns yet. Your story starts here.'];
  for (const entry of log) { const li = document.createElement('li'); li.textContent = entry; $('log').append(li); }
  if (state.status !== 'FLYING') {
    pause(false);
    clearTimeout(previewTimer); previewGeneration++; prediction = null;
    clearForecast('Flight ended', 'Start a new attempt to explore another trajectory.');
    $('outcome').hidden = false;
    $('outcome-label').textContent = state.status === 'ARRIVED' ? 'RENDEZVOUS COMPLETE' : 'ANOTHER ORBIT TO DISCOVER';
    $('outcome-title').textContent = {ARRIVED:'Same place. Same pace.',IMPACT:'A little too close.',TIMEOUT:'Time for another try.'}[state.status];
    $('outcome-message').textContent = state.message;
    $('story').textContent = state.status === 'ARRIVED' ? '“There you are. I knew you would find me.”' : '“I’m still here. We can try again.”';
  } else {
    $('outcome').hidden = true;
    $('story').textContent = state.distance_km < 120 ? '“I can see you. Now match my speed.”' : state.burns.length ? '“A new path. I’ll meet you where our futures cross.”' : '“I’ll be here. Just remember — I’m moving, too.”';
  }
  controls();
}
function fail(error) {
  pause(false);
  feedback(error.message || 'Connection interrupted. Please retry.', true);
  $('connection').textContent = 'Check API connection';
}
async function mutate(path, body) {
  if (busy) return;
  pause(false); busy = true; prediction = null; previewGeneration++; controls();
  try {
    update(await api(path,body));
    feedback(path === 'burn' ? state.message : path === 'reset' ? 'Aster has a new starting position. Find your meeting window.' : 'One minute farther along your orbit.');
  } catch(error) { fail(error); }
  finally { busy = false; controls(); if (state?.status === 'FLYING') schedulePreview(); }
}
function clearForecast(status, note) {
  $('forecast-status').textContent = status;
  $('predicted-distance').textContent = '—';
  $('predicted-time').textContent = '—';
  $('forecast-note').textContent = note;
}
function schedulePreview() {
  clearTimeout(previewTimer);
  const generation = ++previewGeneration;
  prediction = null;
  clearForecast('Calculating…', 'Calculating a new trajectory from your current position.');
  previewTimer = setTimeout(() => loadPreview(generation), 240);
}
async function loadPreview(generation) {
  if (!state || playing || state.status !== 'FLYING') return;
  const requestTime = state.time;
  try {
    const data = await api('preview', {magnitude_m_s:magnitude(), angle_deg:angle()});
    if (generation !== previewGeneration || playing || state.time !== requestTime) return;
    prediction = data;
    $('predicted-distance').textContent = `${money(data.closest.distance_km)} km`;
    $('predicted-time').textContent = `${(data.closest.in_seconds/60).toFixed(1)} min`;
    $('forecast-status').textContent = data.impact ? 'Impact course' : 'Updated';
    $('forecast-note').textContent = data.impact ? 'This trajectory intersects Mars. Try changing the burn.' : `${money(data.closest.relative_speed_m_s)} m/s predicted relative speed. Arrival needs ≤30 m/s.`;
  } catch(error) {
    if (generation !== previewGeneration) return;
    $('forecast-status').textContent = 'Unavailable';
    $('forecast-note').textContent = error.message;
    $('predicted-distance').textContent = '—'; $('predicted-time').textContent = '—';
  }
}
function planChanged() {
  pause(false);
  const selected = angle();
  $('angle-value').textContent = `${selected}°`;
  document.querySelectorAll('[data-angle]').forEach(button => button.classList.toggle('selected', Number(button.dataset.angle) === selected));
  $('direction-note').textContent = selected === 0 ? 'Along your orbit. A prograde burn adds orbital energy.' : Math.abs(selected) === 180 ? 'Against your orbit. A retrograde burn removes orbital energy.' : selected === 90 ? 'Away from Mars. A radial burn changes the shape of your orbit.' : selected === -90 ? 'Toward Mars. Watch the predicted altitude carefully.' : 'Direction is relative to the local orbit. You can also click the map to aim.';
  controls(); schedulePreview();
}
$('magnitude').addEventListener('input', () => { $('magnitude-number').value = $('magnitude').value; planChanged(); });
$('magnitude-number').addEventListener('input', () => {
  const value = Math.max(0, Math.min(450, Number($('magnitude-number').value) || 0));
  $('magnitude').value = value; $('magnitude-number').value = value; planChanged();
});
$('angle').addEventListener('input', planChanged);
for (const button of document.querySelectorAll('[data-angle]')) button.onclick = () => { $('angle').value = button.dataset.angle; planChanged(); };
$('burn').onclick = () => mutate('burn', {magnitude_m_s:magnitude(), angle_deg:angle()});
$('step').onclick = () => mutate('step', {seconds:60});
function reset() { $('magnitude').value = $('magnitude-number').value = 300; $('angle').value = 0; planChanged(); mutate('reset',{}); }
$('reset').onclick = reset; $('retry').onclick = reset;
$('play').onclick = () => {
  if (playing) { pause(); feedback('Paused. Plan your next move.'); return; }
  startPlayback();
};
function startPlayback() {
  if (!state || state.status !== 'FLYING') return;
  playing = true; prediction = null; previewGeneration++; clearTimeout(previewTimer);
  clearForecast('Paused in flight', 'Pause the flight to plan another burn.');
  $('play').innerHTML = 'Ⅱ <span>Pause</span>'; $('play').setAttribute('aria-label','Pause simulation');
  lastTick = performance.now();
  feedback(stopAt !== null ? 'Coasting. Time will pause at predicted closest approach.' : 'Gravity is doing the flying. Pause whenever you need.');
  update(state);
}
$('coast').onclick = async () => {
  if (busy) return;
  pause(false); busy = true; controls(); feedback('Finding the next encounter along your current orbit…');
  try {
    const future = await api('preview', {magnitude_m_s:0, angle_deg:0});
    if (future.closest.in_seconds < 1) { feedback('You are at the nearest point on this predicted path. Consider a burn.'); return; }
    stopAt = state.time + future.closest.in_seconds;
    startPlayback();
  } catch(error) {fail(error);}
  finally {busy = false; controls();}
};
setInterval(async () => {
  if (!playing || busy || !state || state.status !== 'FLYING') return;
  const now = performance.now();
  let seconds = Math.min(600, (now-lastTick)/1000*Number($('speed').value));
  lastTick = now;
  if (stopAt !== null) seconds = Math.min(seconds, Math.max(0,stopAt-state.time));
  if (seconds <= .000001) { pause(); feedback('Closest approach. Check distance and match the station’s velocity.'); return; }
  busy = true; controls();
  // Keep pause available while a step is in flight; all state-changing actions serialize.
  $('play').disabled = false;
  try {
    update(await api('step',{seconds}));
    if (stopAt !== null && state.time >= stopAt-.000001) { pause(); feedback('Closest approach. Check distance and match the station’s velocity.'); }
  } catch(error) {fail(error);}
  finally {busy = false; controls();}
},160);
document.addEventListener('visibilitychange', () => {if (document.hidden) pause();});
function openDialog(id) {pause(); $(id).showModal(); $(id).scrollTop = 0;}
$('notes-button').onclick = () => openDialog('notes');
$('close-notes').onclick = () => $('notes').close();
$('notes').addEventListener('click', event => {if (event.target === $('notes')) $('notes').close();});
$('log-button').onclick = () => openDialog('history');
$('close-history').onclick = () => $('history').close();
$('history').addEventListener('click', event => {if (event.target === $('history')) $('history').close();});
const helpTabs = ['play', 'physics'];
function selectHelpTab(name) {
  for (const tab of helpTabs) {
    const selected = tab === name;
    $(`${tab}-tab`).setAttribute('aria-selected', String(selected));
    $(`${tab}-tab`).tabIndex = selected ? 0 : -1;
    $(`${tab}-guide`).hidden = !selected;
  }
}
for (const name of helpTabs) {
  $(`${name}-tab`).onclick = () => selectHelpTab(name);
  $(`${name}-tab`).onkeydown = event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'play' : event.key === 'End' ? 'physics' : helpTabs.find(tab => tab !== name);
    selectHelpTab(next); $(`${next}-tab`).focus();
  };
}
$('zoom-in').onclick = () => zoom = Math.min(1.6, zoom*1.15);
$('zoom-out').onclick = () => zoom = Math.max(.45,zoom/1.15);
$('zoom-fit').onclick = () => zoom = 1;
canvas.addEventListener('click', event => {
  if (!state || busy || state.status !== 'FLYING') return;
  const bounds = canvas.getBoundingClientRect();
  const dx=(event.clientX-bounds.left-origin[0])/scale-state.ship.position[0];
  const dy=-(event.clientY-bounds.top-origin[1])/scale-state.ship.position[1];
  const theta=Math.atan2(state.ship.position[1],state.ship.position[0]);
  const outward=dx*Math.cos(theta)+dy*Math.sin(theta), along=-dx*Math.sin(theta)+dy*Math.cos(theta);
  $('angle').value=Math.round(Math.atan2(outward,along)*180/Math.PI); planChanged();
});

// Illustration only: all flight positions and predictions come from the API.
const planet = document.createElement('canvas'); planet.width=planet.height=480;
const pc=planet.getContext('2d'), texture=pc.createImageData(480,480);
for(let y=0;y<480;y++)for(let x=0;x<480;x++){
  const nx=(x-240)/239,ny=(y-240)/239,r2=nx*nx+ny*ny;if(r2>1)continue;
  const nz=Math.sqrt(1-r2),lon=Math.atan2(nx,nz),lat=Math.asin(ny);
  const terrain=Math.sin(lon*11+Math.sin(lat*13)*1.1)*Math.cos(lat*15+lon*4)*.11+Math.sin(lon*38+lat*20)*.035;
  const basin=Math.exp(-((nx+.23)**2/.10+(ny-.20)**2/.024))*.36;
  const dust=.85+terrain-basin;
  const light=Math.max(.06,-nx*.63-ny*.43+nz*.65);
  const i=(y*480+x)*4;
  texture.data[i]=Math.min(255,205*dust*light+9);
  texture.data[i+1]=Math.min(255,112*dust*light+6);
  texture.data[i+2]=Math.min(255,75*dust*light+5);
  texture.data[i+3]=Math.min(255,(1-r2)*5000);
}
pc.putImageData(texture,0,0);
const stars=Array.from({length:210},(_,i)=>({x:fract(Math.sin(i*127.1+10)*43758.5453),y:fract(Math.sin(i*311.7+22)*19513.174),r:i%13===0?1.25:.55,a:.12+(i%7)*.055}));
function fract(v){return v-Math.floor(v);}
new ResizeObserver(() => {
  width=canvas.clientWidth;height=canvas.clientHeight;
  const dpr=Math.min(devicePixelRatio||1,2);
  canvas.width=width*dpr;canvas.height=height*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);
}).observe(canvas);
function project(p){return [origin[0]+p[0]*scale,origin[1]-p[1]*scale];}
function circle(x,y,r,color,line=1){ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.strokeStyle=color;ctx.lineWidth=line;ctx.stroke();}
function path(points,color,dashed=false){if(!points?.length)return;ctx.beginPath();points.forEach((p,i)=>{const [x,y]=project(p);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.strokeStyle=color;ctx.lineWidth=1.3;ctx.setLineDash(dashed?[4,6]:[]);ctx.stroke();ctx.setLineDash([]);}
function label(text,p,color,offset=16){const [x,y]=project(p);ctx.font='10px ui-monospace, monospace';ctx.fillStyle=color;const left=x>width-130;ctx.textAlign=left?'right':'left';ctx.fillText(text,x+(left?-offset:offset),y-12);ctx.textAlign='left';}
function draw(){
  ctx.clearRect(0,0,width,height);
  for(const star of stars){ctx.fillStyle=`rgba(184,207,220,${star.a})`;ctx.beginPath();ctx.arc(star.x*width,star.y*height,star.r,0,7);ctx.fill();}
  origin=[width*.49,height*.54];scale=Math.min(width*.44,height*.38)/7500*zoom;
  if(state){
    const radius=state.planet_radius_km*scale;
    for(const orbit of [state.inner_radius_km,state.outer_radius_km]){ctx.setLineDash([2,6]);circle(...origin,orbit*scale,'#35434e');ctx.setLineDash([]);}
    // Small axis ticks give the map scale without covering it in a grid.
    for(let i=0;i<72;i++){const a=i*Math.PI/36,r=state.outer_radius_km*scale;const len=i%6===0?5:2;ctx.beginPath();ctx.moveTo(origin[0]+Math.cos(a)*(r+9),origin[1]+Math.sin(a)*(r+9));ctx.lineTo(origin[0]+Math.cos(a)*(r+9+len),origin[1]+Math.sin(a)*(r+9+len));ctx.strokeStyle='#40515a';ctx.lineWidth=.6;ctx.stroke();}
    if(prediction && Math.abs(prediction.from_time-state.time)<.001)path(prediction.points,'#abd8c8a0',true);
    path(state.trail,'#ec9c74');
    const haze=ctx.createRadialGradient(...origin,radius*.8,...origin,radius*1.2);haze.addColorStop(0,'#dc795810');haze.addColorStop(.65,'#bc67491c');haze.addColorStop(1,'#a1513900');ctx.fillStyle=haze;ctx.beginPath();ctx.arc(...origin,radius*1.2,0,7);ctx.fill();
    ctx.drawImage(planet,origin[0]-radius,origin[1]-radius,radius*2,radius*2);
    ctx.fillStyle='#e3a58680';ctx.font='11px ui-monospace, monospace';ctx.textAlign='center';ctx.fillText('M A R S',origin[0],origin[1]+radius*.65);ctx.textAlign='left';
    const [tx,ty]=project(state.target.position);
    circle(tx,ty,14,'#a8d8c535');circle(tx,ty,8,'#b0ddc9');ctx.save();ctx.translate(tx,ty);ctx.rotate(Math.PI/4);ctx.fillStyle='#b0ddc9';ctx.fillRect(-3,-3,6,6);ctx.restore();label('ASTER / LYRA',state.target.position,'#b0ddc9',21);
    const [sx,sy]=project(state.ship.position);
    const v=state.ship.velocity,heading=Math.atan2(-v[1],v[0]);
    ctx.save();ctx.translate(sx,sy);ctx.rotate(heading);ctx.shadowColor='#ec9c74';ctx.shadowBlur=12;ctx.beginPath();ctx.moveTo(9,0);ctx.lineTo(-6,-5);ctx.lineTo(-3,0);ctx.lineTo(-6,5);ctx.closePath();ctx.fillStyle='#ffc3a1';ctx.fill();ctx.restore();
    circle(sx,sy,17,'#ec9c7428');label('YOU',state.ship.position,'#ecaf8f',23);
    // A small arrow shows the chosen impulse direction, not a new trajectory.
    if(!playing && state.status==='FLYING' && magnitude()>0){const theta=Math.atan2(state.ship.position[1],state.ship.position[0]),a=angle()*Math.PI/180;const dx=-Math.sin(theta)*Math.cos(a)+Math.cos(theta)*Math.sin(a),dy=Math.cos(theta)*Math.cos(a)+Math.sin(theta)*Math.sin(a);const length=25+magnitude()/12;ctx.beginPath();ctx.moveTo(sx+dx*13,sy-dy*13);ctx.lineTo(sx+dx*length,sy-dy*length);ctx.strokeStyle='#e9ae8d';ctx.lineWidth=1.5;ctx.stroke();const hx=sx+dx*length,hy=sy-dy*length;ctx.beginPath();ctx.moveTo(hx-dx*7-dy*3,hy+dy*7-dx*3);ctx.lineTo(hx,hy);ctx.lineTo(hx-dx*7+dy*3,hy+dy*7+dx*3);ctx.stroke();}
    const scaleBar=document.querySelector('.map-scale>span:first-child');scaleBar.style.width=`${1000*scale}px`;
  }
  requestAnimationFrame(draw);
}
draw();
controls();
try {update(await api('state'));schedulePreview();} catch(error){fail(error);}
