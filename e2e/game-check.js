/** End-to-end play test for the game. Uses the actual browser controls. Start the game first. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const base=process.env.GAME_URL||'http://127.0.0.1:8000';
const output=new URL('./test-results/game/',import.meta.url);
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
try{
  await page.request.post(`${base}/game/reset`);
  await page.goto(`${base}/play/`);
  await page.waitForFunction(()=>document.querySelector('#forecast-status').textContent==='Updated');
  assert.match(await page.locator('#engine').textContent(),/BASILISK|NEWTONIAN/);
  const initial=await(await page.request.get(`${base}/game/state`)).json();
  const viewports=[{width:1440,height:900},{width:1366,height:768},{width:1280,height:680},{width:1024,height:640},{width:900,height:620}];
  for(const viewport of viewports){
    await page.setViewportSize(viewport);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const fit=await page.evaluate(()=>({
      page:document.documentElement.scrollHeight<=innerHeight && document.documentElement.scrollWidth<=innerWidth,
      planner:document.querySelector('.planner').scrollHeight<=document.querySelector('.planner').clientHeight,
      visible:['play','step','burn','coast','distance','relative-speed','log-button'].every(id=>{
        const r=document.getElementById(id).getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight && r.left>=0 && r.right<=innerWidth;
      })
    }));
    assert.deepEqual(fit,{page:true,planner:true,visible:true},`All controls must fit at ${viewport.width}×${viewport.height}: ${JSON.stringify(fit)}`);
  }
  await page.setViewportSize({width:1440,height:900});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.screenshot({path:fileURLToPath(new URL('01-plan.png',output)),fullPage:true});
  await page.locator('#notes-button').click();
  assert.equal(await page.locator('#notes').evaluate(d=>d.open),true);
  assert.equal(await page.locator('#play-guide').isVisible(),true);
  await page.screenshot({path:fileURLToPath(new URL('05-instructions.png',output)),fullPage:true});
  await page.locator('#physics-tab').click();
  assert.equal(await page.locator('#physics-guide').isVisible(),true);
  assert.equal(await page.locator('#play-guide').isVisible(),false);
  await page.screenshot({path:fileURLToPath(new URL('06-physics.png',output)),fullPage:true});
  await page.locator('#physics-tab').press('ArrowLeft');
  assert.equal(await page.locator('#play-tab').getAttribute('aria-selected'),'true');
  await page.locator('#close-notes').click();
  await page.locator('#step').click();
  await page.waitForFunction(()=>document.querySelector('#clock').textContent.includes('00:01:00'));
  await page.locator('#play').click();
  await page.waitForTimeout(500);
  await page.getByRole('button',{name:'Pause simulation'}).click();
  // Wait for an already-issued API step to finish, then verify a paused clock stays still.
  await page.waitForTimeout(350);
  const paused=await(await page.request.get(`${base}/game/state`)).json();
  await page.waitForTimeout(400);
  const still=await(await page.request.get(`${base}/game/state`)).json();
  assert.equal(paused.time,still.time);
  assert(paused.time>60);
  await page.locator('#reset').click();
  await page.waitForFunction(()=>document.querySelector('#clock').textContent.includes('00:00:00'));
  const randomized=await(await page.request.get(`${base}/game/state`)).json();
  assert.notDeepEqual(randomized.target.position,initial.target.position);
  // Independently solve the randomized launch window for the end-to-end test.
  // The game UI does not calculate or expose this solution to the player.
  const mu=42828.314,r1=4000,r2=6000,tau=2*Math.PI;
  const n1=Math.sqrt(mu/r1**3),n2=Math.sqrt(mu/r2**3);
  const transferTime=Math.PI*Math.sqrt(((r1+r2)/2)**3/mu);
  const phase=(Math.atan2(randomized.target.position[1],randomized.target.position[0])-Math.atan2(randomized.ship.position[1],randomized.ship.position[0])+tau)%tau;
  const departureWait=(phase-(Math.PI-n2*transferTime)+tau)%tau/(n1-n2);
  let remainingWait=departureWait;
  while(remainingWait>1e-6){
    const seconds=Math.min(600,remainingWait);
    const response=await page.request.post(`${base}/game/step`,{data:{seconds}});
    assert(response.ok());remainingWait-=seconds;
  }
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('#forecast-status').textContent==='Updated');
  await page.locator('#magnitude-number').fill('312.3');
  await page.locator('[data-angle="0"]').click();
  await page.waitForFunction(()=>document.querySelector('#forecast-status').textContent==='Updated');
  await page.locator('#burn').click();
  await page.waitForFunction(()=>document.querySelector('#burn-count').textContent==='1 maneuver');
  const afterBurn=await(await page.request.get(`${base}/game/state`)).json();
  assert(afterBurn.ship.speed>initial.ship.speed);
  assert(Math.abs(afterBurn.time-departureWait)<1e-6);
  await page.locator('#coast').click();
  await page.waitForFunction(()=>document.querySelector('#feedback').textContent.startsWith('Closest approach.'),{},{timeout:45000});
  const encounter=await(await page.request.get(`${base}/game/state`)).json();
  assert(encounter.distance_km<20);
  assert(encounter.relative_speed_m_s>30);
  assert.equal(encounter.status,'FLYING');
  assert(await page.locator('#distance-check').evaluate(e=>e.classList.contains('met')));
  assert.equal(await page.locator('#speed-check').evaluate(e=>e.classList.contains('met')),false);
  assert.equal(await page.locator('#flight-status').textContent(),'PAUSED');
  await page.screenshot({path:fileURLToPath(new URL('02-encounter.png',output)),fullPage:true});
  await page.locator('#magnitude-number').fill('282.1');
  await page.locator('#burn').click();
  await page.waitForFunction(()=>!document.querySelector('#outcome').hidden);
  const arrived=await(await page.request.get(`${base}/game/state`)).json();
  assert.equal(arrived.status,'ARRIVED');
  assert(await page.locator('#speed-check').evaluate(e=>e.classList.contains('met')));
  assert(arrived.relative_speed_m_s<30);
  await page.screenshot({path:fileURLToPath(new URL('03-arrived.png',output)),fullPage:true});
  await page.locator('#retry').click();
  await page.waitForFunction(()=>document.querySelector('#outcome').hidden);
  assert.equal((await(await page.request.get(`${base}/game/state`)).json()).remaining_dv,800);
  await page.locator('#magnitude-number').fill('450');
  await page.locator('[data-angle="180"]').click();
  await page.waitForFunction(()=>document.querySelector('#forecast-status').textContent==='Impact course');
  await page.locator('#burn').click();
  await page.waitForFunction(()=>document.querySelector('#burn-count').textContent==='1 maneuver');
  await page.locator('#play').click();
  await page.waitForFunction(()=>!document.querySelector('#outcome').hidden,{},{timeout:30000});
  assert.equal((await(await page.request.get(`${base}/game/state`)).json()).status,'IMPACT');
  assert.equal(await page.locator('#forecast-status').textContent(),'Flight ended');
  await page.locator('#retry').click();
  await page.waitForFunction(()=>document.querySelector('#forecast-status').textContent==='Updated');
  await page.locator('#log-button').click();
  assert.equal(await page.locator('#history').evaluate(d=>d.open),true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#history').evaluate(d=>d.open),false);
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:fileURLToPath(new URL('04-mobile.png',output)),fullPage:true});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);
  const report={physics:initial.physics_engine,play_pause:'passed',step:'passed',
    departure_burn_m_s:312.3,arrival_burn_m_s:282.1,
    encounter_time:encounter.time,encounter_distance_km:encounter.distance_km,
    flyby_speed_m_s:encounter.relative_speed_m_s,arrival_speed_m_s:arrived.relative_speed_m_s,
    outcome:arrived.status,random_start:'passed',departure_wait:departureWait,impact_and_retry:'passed',desktop_viewports:viewports,
    help_dialog:'passed',win_indicators:'passed',mobile_overflow:false,browser_errors:errors};
  await writeFile(new URL('report.json',output),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}catch(error){
  console.log('Browser errors',errors);
  console.log((await page.locator('body').innerText()).slice(0,4500));
  await page.screenshot({path:fileURLToPath(new URL('failure.png',output)),fullPage:true});
  throw error;
}finally{await browser.close();}
