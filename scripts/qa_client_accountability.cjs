// Requires an installed Playwright package; all API traffic uses isolated fixtures.
const { chromium } = require(process.env.VILO_PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.VILO_QA_BASE_URL || 'http://127.0.0.1:3100';
const artifactDir = process.env.VILO_QA_ARTIFACT_DIR || require('node:os').tmpdir();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const user = {id:1,organization_id:1,name:'Daniel Brooks',email:'qa@example.test',role:'partner',status:'active'};
const areas = ['Civil Litigation','Criminal Law','Family Law','Conveyancing','Probate & Estate','Corporate / Commercial','Employment Law','Personal Injury','Immigration','Real Estate','Other'];
const timestamp = '2026-10-01T09:45:00Z';
const doc = {id:51,title:'Notification document',file_name:'shared.txt',file_type:'text/plain',file_size:100,category:'general',case_id:1,client_id:1,visibility:'internal',uploaded_by:1,version:1,created_at:timestamp,updated_at:timestamp,last_edited_by_name:'Daniel Brooks',last_edited_by_user_id:1,last_edited_at:timestamp};
const baseCase = {id:1,title:'Smith v Brown',practice_area:'Civil Litigation',client_id:1,client_name:'Smith',priority:'high',status:'active',assigned_users:[],created_at:timestamp,updated_at:timestamp};
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.VILO_CHROMIUM_EXECUTABLE || undefined});
 const results=[];
 for(const zoom of [1,1.1,1.25]){
  const context=await browser.newContext({viewport:{width:Math.round(1440/zoom),height:Math.round(960/zoom)},deviceScaleFactor:zoom,timezoneId:'Asia/Dhaka'});
  await context.addInitScript(({user})=>{localStorage.setItem('vilo_access_token','qa-fixture');localStorage.removeItem('vilo_user');},{user});
  let activeUser=user;
  let cases=[{...baseCase}, {...baseCase,id:2,title:'Historical File',priority:'low',practice_area:null}], marked=0, created=null;
  let messages=[{id:1,conversation_id:7,sender_id:1,body:'Outgoing sent',delivery_status:'sent',read_at:null,created_at:timestamp,attachments:[],case_references:[]},{id:2,conversation_id:7,sender_id:1,body:'Outgoing delivered ' + 'Long message text with readable timestamp. '.repeat(12),delivery_status:'delivered',read_at:null,created_at:timestamp,attachments:[{id:21,file_name:'very-long-attachment-name-'.repeat(8)+'.txt',file_type:'text/plain',file_size:100}],case_references:[]},{id:3,conversation_id:7,sender_id:1,body:'Hi',delivery_status:'read',read_at:'2026-10-01T09:52:00Z',created_at:timestamp,attachments:[],case_references:[]},{id:4,conversation_id:7,sender_id:3,sender_name:'User B',body:'Incoming message',delivery_status:'read',created_at:timestamp,attachments:[],case_references:[]}];
  messages.unshift(...Array.from({length:45},(_,i)=>({id:100+i,conversation_id:7,sender_id:3,sender_name:'User B',body:`History ${i} ${'Earlier content. '.repeat(8)}`,created_at:timestamp,attachments:[],case_references:[]})));
  const conv={id:7,title:'Receipt QA',conversation_type:'internal',participant_count:3,unread_count:1,latest_message:messages.at(-1),created_at:timestamp,updated_at:timestamp};
  const notifications=[{id:1,title:'Document shared',type:'document_uploaded',metadata:{document_id:51,case_id:1},is_read:false,created_at:timestamp}];
  const requests=[];
  await context.route('**/api/v1/**',async route=>{
   const req=route.request(),url=new URL(req.url()),p=url.pathname; requests.push({method:req.method(),path:p,search:url.search});
   let response=[];
   if(p==='/api/v1/auth/me')response=activeUser;
   else if(p==='/api/v1/cases/practice-areas')response=areas;
   else if(p==='/api/v1/cases/query'){const priority=url.searchParams.get('priority');const rows=cases.filter(c=>!priority||c.priority===priority);response={items:rows,total:rows.length,total_pages:1,counts:[{status:'active',count:cases.length}]};}
   else if(p==='/api/v1/cases'&&req.method()==='POST'){created=req.postDataJSON();const c={...baseCase,...created,id:3};cases.push(c);response=c;}
   else if(p==='/api/v1/cases')response=cases;
   else if(p==='/api/v1/cases/1')response=baseCase;
   else if(p==='/api/v1/cases/1/timeline')response=[
    {id:71,title:'Document edited: TEST1',event_type:'Document_onlyoffice_edited',created_at:'2026-10-02T08:07:00Z',event_date:'2025-01-01',actor_id:1,actor_name:'Daniel Brooks',metadata:{document_id:51}},
    {id:72,title:'Document uploaded: TEST1',event_type:'document_uploaded',created_at:'2026-10-02T07:55:00Z',actor_id:3,actor_name:'Olivia Grant',metadata:{document_id:51}},
    {id:73,title:'Task created: Prepare affidavit',event_type:'task_created',created_at:'2026-10-02T07:43:00Z',actor_id:null,actor_name:null,metadata:{task_id:23}}
   ];
   else if(p==='/api/v1/clients')response=[{id:1,name:'Smith'}];
   else if(p==='/api/v1/clients/1')response={id:1,name:'Smith',status:'active',created_at:timestamp,updated_at:timestamp};
   else if(p==='/api/v1/team')response=[user,{...user,id:3,name:'User B',role:'lawyer'}];
   else if(p==='/api/v1/documents/query'){const items=url.searchParams.has('document_id')?[doc]:[doc,{...doc,id:52,title:'Second document'}];response={items,total:items.length,total_pages:1};}
   else if(p==='/api/v1/documents/51/view'){await route.fulfill({status:200,contentType:'text/plain',body:'Protected document text'});return;}
   else if(p==='/api/v1/documents/51/download'){await route.fulfill({status:200,contentType:'text/plain',headers:{'content-disposition':'attachment; filename="shared.txt"'},body:'Protected document text'});return;}
   else if(p==='/api/v1/conversations/attachments/21/view'){await route.fulfill({status:200,contentType:'text/plain',body:'Protected message attachment'});return;}
   else if(p==='/api/v1/conversations/attachments/21/download'){await route.fulfill({status:200,contentType:'text/plain',headers:{'content-disposition':'attachment; filename="attachment.txt"'},body:'Protected message attachment'});return;}
   else if(p==='/api/v1/documents')response=[doc];
   else if(p.startsWith('/api/v1/notifications')&&req.method()==='GET')response={items:p.includes('popup')?[]:notifications,unread_count:1};
   else if(p==='/api/v1/time-entries/active-timer')response=null;
   else if(p==='/api/v1/portal/messages/conversations')response=[{...conv,conversation_type:'client'}];
   else if(p==='/api/v1/portal/messages/conversations/7/messages')response=messages.map(m=>({...m,sender_id:m.sender_id===1?6:m.sender_id}));
   else if(p==='/api/v1/portal/messages/conversations/7/mark-read'){marked++;response={ok:true};}
   else if(p==='/api/v1/conversations')response=[conv,{...conv,id:8,title:'Second conversation',unread_count:0}];
   else if(p==='/api/v1/conversations/8/messages')response=messages.map(m=>({...m,conversation_id:8}));
   else if(p==='/api/v1/conversations/8/participants')response=[{user_id:1,role:'owner'},{user_id:3,role:'member'}];
   else if(p==='/api/v1/conversations/8/mark-read'){marked++;response={ok:true};}
   else if(p==='/api/v1/conversations/7/messages'){if(req.method()==='POST'){messages.push({id:1000,sender_id:1,body:req.postDataJSON().body,created_at:timestamp,delivery_status:'sent'});}response=messages;}
   else if(p==='/api/v1/conversations/7/participants')response=[{user_id:1,role:'owner'},{user_id:3,role:'member'}];
   else if(p==='/api/v1/conversations/7/mark-read'){marked++;response={ok:true};}
   else if(p==='/api/v1/conversations/7')response=conv;
   else if(p.includes('/reports/'))response={today_overview:{unread_messages_count:1}};
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(response)});
  });
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message)});page.on('console',m=>{if(m.type()==='error')console.error('CONSOLE',m.text())});
  await page.goto(`${baseUrl}/dashboard/documents`);
  await page.getByRole('button',{name:'Actions for Second document',exact:true}).waitFor();
  await page.getByRole('button',{name:'Actions for Notification document',exact:true}).click();
  await page.getByRole('heading',{name:'Documents',exact:true}).click();
  await page.getByRole('button',{name:'Actions for Second document',exact:true}).click();
  await page.getByRole('menu',{name:'Actions for Second document',exact:true}).waitFor();
  assert.equal(await page.locator('.documents-actions-menu--portal').count(),1);
  assert.equal(await page.getByRole('menu',{name:'Actions for Second document',exact:true}).count(),1);
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Notifications',exact:true}).click();
  await page.locator('.dashboard-navbar__notification-item').filter({hasText:'Document shared'}).click();
  await page.waitForURL('**/dashboard/documents?document_id=51');
  try {await page.getByRole('button',{name:'Actions for Notification document',exact:true}).waitFor({timeout:10000});} catch(e){console.log('PAGE',await page.locator('body').innerText());console.log('REQUESTS',requests);await page.screenshot({path:`${artifactDir}/vilo-batch-error.png`});throw e;}
  assert(requests.some(r=>r.path==='/api/v1/documents/query'&&r.search.includes('document_id=51')));
  await page.getByText('Last edited by Daniel Brooks on',{exact:false}).first().waitFor();
  const trigger=page.getByRole('button',{name:'Actions for Notification document',exact:true});
  await trigger.click();const menu=page.getByRole('menu',{name:'Actions for Notification document',exact:true});await menu.waitFor();
  let rect=await menu.boundingBox(),anchor=await trigger.boundingBox();const viewport=page.viewportSize();
  assert(rect.x>=0&&rect.y>=0&&rect.x+rect.width<=viewport.width+1&&rect.y+rect.height<=viewport.height+1,JSON.stringify({rect,viewport}));
  assert(Math.abs(rect.x+rect.width-anchor.x-anchor.width)<3||rect.x===8);
  const hit=await menu.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+20));});assert(hit,'Menu obscured by table/pagination');
  await page.screenshot({path:`${artifactDir}/vilo-doc-menu-${Math.round(zoom*100)}.png`});
  await page.keyboard.press('Escape');await menu.waitFor({state:'detached'});
  await trigger.click();await page.getByRole('heading',{name:'Documents',exact:true}).click();await menu.waitFor({state:'detached'});
  await trigger.click();await menu.getByRole('menuitem',{name:'View',exact:true}).click();await page.getByRole('dialog').waitFor();
  await page.getByText('Protected document text',{exact:true}).waitFor();
  await page.getByRole('dialog').getByText('Last edited by Daniel Brooks on',{exact:false}).waitFor();
  assert(requests.some(r=>r.path==='/api/v1/documents/51/view'));
  await page.getByRole('button',{name:'Close preview',exact:true}).click();
  // Force bottom-edge placement by making the viewport end just below the exact trigger.
  anchor=await trigger.boundingBox();await page.setViewportSize({width:viewport.width,height:Math.ceil(anchor.y+anchor.height+50)});
  await trigger.click();await menu.waitFor();rect=await menu.boundingBox();anchor=await trigger.boundingBox();assert(rect.y<anchor.y,'Expected upward placement near bottom');
  await page.keyboard.press('Escape');await page.setViewportSize(viewport);
  await page.goto(`${baseUrl}/dashboard/messages`);await page.getByText('Select a conversation to view messages.',{exact:true}).waitFor();assert.equal(marked,0);
  await page.locator('.messages-conversation-item').first().click();
  await page.getByText('Hi',{exact:true}).waitFor();
  await page.locator('.message-receipt').first().waitFor();assert.equal(await page.locator('.message-receipt').count(),1);
  assert.equal(await page.locator('.message-receipt.is-read').count(),1);
  assert.equal(await page.locator('.message-receipt__ticks').count(),0);
  await page.locator('.message-receipt.is-read').waitFor();await verifyReceipts(page);assert(marked>0);
  await verifyScroll(page, async label => {
    messages.push({id:2000+messages.length,sender_id:3,sender_name:'User B',body:label,created_at:timestamp});
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await page.getByText(label,{exact:true}).waitFor();
  });
  await page.locator('.messages-thread__body').evaluate(el=>{el.scrollTop=150;el.dispatchEvent(new Event('scroll'))});
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('My latest message');
  await page.getByRole('textbox',{name:'Message',exact:true}).press('Enter');
  await page.getByText('My latest message',{exact:true}).waitFor();await assertBottom(page);
  await page.locator('.messages-conversation-item').nth(1).click();await page.getByText('Hi',{exact:true}).waitFor();await assertBottom(page);
  await page.locator('.messages-thread__body').evaluate(el=>{el.scrollTop=150;el.dispatchEvent(new Event('scroll'))});
  await page.locator('.messages-conversation-item').first().click();await assertBottom(page);
  await page.setViewportSize({width:390,height:844});await assertBottom(page);await page.setViewportSize(viewport);await assertBottom(page);
  await page.locator('.message-attachment').scrollIntoViewIfNeeded();await page.screenshot({path:`${artifactDir}/vilo-message-attachment-${Math.round(zoom*100)}.png`});
  await page.locator('.message-attachment').getByRole('button',{name:/^Preview /}).click();await page.getByRole('dialog').getByText('Protected message attachment',{exact:true}).waitFor();await page.getByRole('button',{name:'Close preview',exact:true}).click();
  const attachmentDownload=page.waitForEvent('download');await page.locator('.message-attachment').getByRole('button',{name:/^Download /}).click();await attachmentDownload;
  await page.locator('.message-receipt.is-read').scrollIntoViewIfNeeded();await page.screenshot({path:`${artifactDir}/vilo-messages-${Math.round(zoom*100)}.png`});
  // Re-entry through the module URL must not restore and acknowledge the old thread.
  const beforeReturn=marked;
  await page.goto(`${baseUrl}/dashboard/documents`);
  await page.goto(`${baseUrl}/dashboard/messages`);
  await page.getByText('Select a conversation to view messages.',{exact:true}).waitFor();assert.equal(marked,beforeReturn);
  // A hidden exact deep link fetches messages without crossing the read boundary.
  await page.addInitScript(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'})});
  await page.goto(`${baseUrl}/dashboard/messages?conversation=7`);
  await page.getByText('Hi',{exact:true}).waitFor();await assertBottom(page);assert.equal(marked,beforeReturn);
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'))});
  await page.waitForFunction(()=>document.visibilityState==='visible');
  await page.addInitScript(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'})});
  await page.goto(`${baseUrl}/dashboard/cases`);await page.getByRole('columnheader',{name:'Practice Area',exact:true}).waitFor();assert.equal(await page.getByRole('columnheader',{name:'Priority',exact:true}).count(),0);
  await page.getByText('Civil Litigation',{exact:true}).waitFor();await page.locator('.cases-filter-grid select').filter({has:page.locator('option[value=high]')}).selectOption('high');await page.getByText('Historical File',{exact:true}).waitFor({state:'detached'});
  await page.getByRole('button',{name:'+ New Case',exact:true}).click();
  await page.getByPlaceholder('Case title',{exact:true}).fill('Smith v Brown');
  assert.equal(await page.locator('.case-create-modal select').filter({has:page.locator('option[value=\"Civil Litigation\"]')}).evaluate(el=>el.checkValidity()),false);
  await page.locator('.case-create-modal select').filter({has:page.locator('option[value=\"Civil Litigation\"]')}).selectOption('Civil Litigation');
  await page.locator('.case-create-modal select').filter({has:page.locator('option', {hasText:'Select client'})}).selectOption('1');
  await page.locator('.case-create-modal select').filter({has:page.locator('option', {hasText:'High'})}).selectOption('high');
  await page.getByRole('button',{name:'Create Case',exact:true}).click();await page.getByText('Case created successfully.',{exact:true}).waitFor();
  assert.equal(created.title,'Smith v Brown');assert.equal(created.practice_area,'Civil Litigation');assert.equal(created.priority,'high');
  await page.goto(`${baseUrl}/dashboard/cases/1`);await page.getByText('Case/File Title:',{exact:true}).waitFor();await page.getByText('Practice Area:',{exact:true}).waitFor();assert.equal(await page.getByText('Case Type:',{exact:true}).count(),0);
  const timeline=page.locator('.case-timeline-table');await timeline.getByText('Document Edited',{exact:true}).waitFor();
  assert.deepEqual(await timeline.locator('thead th').allTextContents(),['Title','Event Type','Event Date','Time','User']);
  const edited=timeline.locator('tbody tr').filter({hasText:'Document edited: TEST1'});
  assert.equal(await edited.locator('td').nth(2).textContent(),'02/10/2026');assert.equal(await edited.locator('td').nth(3).textContent(),'2:07 PM');assert.equal(await edited.locator('td').nth(4).textContent(),'Daniel Brooks');
  assert.equal(await timeline.locator('tbody tr').nth(1).locator('td').nth(4).textContent(),'Olivia Grant');assert.equal(await timeline.locator('tbody tr').nth(2).locator('td').nth(4).textContent(),'—');
  assert.equal(await timeline.locator('tbody td button').count(),0);assert.equal(await edited.locator('td').count(),5);
  assert(await timeline.evaluate(el=>!el.innerText.includes('onlyoffice')));await timeline.scrollIntoViewIfNeeded();await page.screenshot({path:`${artifactDir}/vilo-timeline-${Math.round(zoom*100)}.png`});
  await page.locator('.case-tabs-nav').getByRole('button',{name:'Documents',exact:true}).click();
  await page.getByText('Last edited by Daniel Brooks on',{exact:false}).waitFor();
  await page.goto(`${baseUrl}/dashboard/clients/1`);
  await page.getByRole('heading',{name:'Client Timeline',exact:true}).waitFor();
  await page.getByText('Last edited by Daniel Brooks on',{exact:false}).waitFor();
  await page.getByRole('button',{name:'View document Notification document',exact:true}).click();
  await page.getByRole('dialog').getByText('Last edited by Daniel Brooks on',{exact:false}).waitFor();
  await page.getByRole('button',{name:'Close preview',exact:true}).click();
  activeUser={...user,id:6,role:'client',name:'Client Smith'};
  const beforePortal=marked;
  await page.goto(`${baseUrl}/portal/messages`);
  await page.getByText('Select a conversation from the list to view your messages.',{exact:true}).waitFor();
  assert.equal(marked,beforePortal);
  await page.locator('.messages-conversation-item').first().click();
  await page.getByText('Hi',{exact:true}).waitFor();
  assert.equal(await page.locator('.message-receipt').count(),1);await verifyReceipts(page);
  await verifyScroll(page, async label => {
    messages.push({id:3000+messages.length,sender_id:3,sender_name:'User B',body:label+' portal',created_at:timestamp});
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await page.getByText(label+' portal',{exact:true}).waitFor();
  });
  await page.setViewportSize({width:390,height:844});await assertBottom(page);await page.setViewportSize(viewport);await assertBottom(page);
  await page.locator('.message-receipt.is-read').scrollIntoViewIfNeeded();await page.screenshot({path:`${artifactDir}/vilo-portal-receipts-${Math.round(zoom*100)}.png`});
  assert(marked>beforePortal);
  assert.deepEqual(errors,[]);
  results.push({scale:zoom,checks:'refined receipts DOM placement/colors/alignment, long text and attachment, group fixture, latest open/reopen/send/pinned receive/history receive/indicator/portal scroll, five timeline columns/types/date/time/historical actors/no row actions; notification click and exact link, one document menu, hidden-tab and module-return read guards, Case Documents and Client Timeline editors, portal neutral entry and read-only receipt, document exact link, menu anchor/bounds/topmost/upward/Escape/outside-click/exact View, editor row/preview, neutral Messages/manual-open/read-only status/incoming exclusion, practice dropdown/create/title/details/table/priority filter',pass:true});
  await context.close();
 }
 await browser.close();fs.writeFileSync(`${artifactDir}/vilo_batch_browser_results.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
})().catch(error=>{console.error(error);process.exit(1)});

async function verifyReceipts(page) {
 const receipts=page.locator('.message-receipt');
 for(let i=0;i<await receipts.count();i++){
  const receipt=receipts.nth(i);
  const result=await receipt.evaluate(el=>{
   const bubble=el.parentElement.querySelector('.message-bubble');
   const r=el.getBoundingClientRect(),b=bubble.getBoundingClientRect();
   const timeElement=bubble.querySelector('.message-bubble__time');
   const time=timeElement.getBoundingClientRect();
   const attachment=bubble.querySelector('.message-attachment')?.getBoundingClientRect();
   const style=getComputedStyle(el);
   return {timeAligned:getComputedStyle(timeElement).textAlign==='right' && Math.abs(time.right-b.right+parseFloat(getComputedStyle(bubble).paddingRight)+1)<2,attachmentSafe:!attachment || (attachment.bottom<=time.top && attachment.right<=b.right),inside:bubble.contains(el),gap:r.top-b.bottom,edge:Math.abs(r.right-b.right),timeInside:time.top>=b.top&&time.bottom<=b.bottom,color:style.color,labelColor:getComputedStyle(el.firstElementChild).color,timeColor:getComputedStyle(el.lastElementChild).color,read:el.classList.contains('is-read'),background:style.backgroundColor,text:el.textContent};
  });
  assert.equal(result.inside,false);assert(result.timeInside);assert(result.timeAligned);assert(result.attachmentSafe);assert(result.gap>=3&&result.gap<=6);assert(result.edge<2);
  assert.equal(result.labelColor,'rgb(37, 131, 235)');assert.equal(result.timeColor,'rgb(102, 112, 133)');assert.equal(result.background,'rgba(0, 0, 0, 0)');
  assert.match(result.text,/^Read \d{1,2}:\d{2} [AP]M$/);assert(!/[✓]/.test(result.text));
 }
 assert.equal(await page.locator('.message-bubble-row:not(.is-mine) .message-receipt').count(),0);
}

async function assertBottom(page) {
 try {await page.waitForFunction(()=>{const el=document.querySelector('.messages-thread__body');return el && el.scrollHeight-el.scrollTop-el.clientHeight<3},{},{timeout:5000});} catch(error) {await page.screenshot({path:`${artifactDir}/vilo-scroll-failure.png`});console.log('SCROLL FAILURE',await page.locator('.messages-thread__body').evaluate(el=>({height:el.clientHeight,scrollHeight:el.scrollHeight,top:el.scrollTop,viewport:innerWidth})));throw error;}
}
async function verifyScroll(page, append) {
 await assertBottom(page);
 assert(await page.locator('.messages-thread__body').evaluate(el=>el.scrollHeight>el.clientHeight+500),'Fixture must have a scrolling history');
 const thread=page.locator('.messages-thread__body');
 await append('Incoming while pinned');await assertBottom(page);
 await thread.evaluate(el=>{el.scrollTop=150;el.dispatchEvent(new Event('scroll'))});
 assert.equal(await page.getByRole('button',{name:'Jump to latest message'}).count(),0);
 const before=await thread.evaluate(el=>el.scrollTop);
 await append('Incoming while reading history');
 await page.getByRole('button',{name:'Jump to latest message'}).waitFor();
 assert(Math.abs(await thread.evaluate(el=>el.scrollTop)-before)<2,'Upward reading position must be preserved');
 await page.getByRole('button',{name:'Jump to latest message'}).click();await assertBottom(page);
 assert.equal(await page.getByRole('button',{name:'Jump to latest message'}).count(),0);
 await thread.evaluate(el=>{el.scrollTop=150;el.dispatchEvent(new Event('scroll'))});
 await page.locator('.messages-conversation-item').first().click();await assertBottom(page);
}
