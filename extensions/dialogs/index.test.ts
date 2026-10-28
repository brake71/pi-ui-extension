import assert from "node:assert/strict";
import test from "node:test";
import { createDialogUI, modalFrame } from "./index.ts";
import { stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
const theme={fg(_key:string,text:string){return text;},bold(text:string){return text;}} as any;
type Modal=Component&{handleInput(data:string):void};
function fakeUI(rows=35,columns=100){
 const active:Modal[]=[],options:any[]=[];let closes=0;
 const tui={terminal:{rows,columns},requestRender(){}} as any;
 const ui={select(){throw Error('native selector')},input(){throw Error('native input')},confirm(){throw Error('native confirm')},editor(){throw Error('native editor')},notify(){},
 custom<T>(factory:any,opts:any):Promise<T>{options.push(opts);return new Promise<T>((resolve)=>{const modal=factory(tui,theme,{},(value:T)=>{closes++;resolve(value)});active.push(modal)})}} as any;
 return {ui:createDialogUI(ui),active,options,tui,get closes(){return closes}};
}
const plain=(c:Component,w=66)=>c.render(w).map(stripTerminalSequences);
test('danger confirmation defaults to cancel in a centered overlay',async()=>{
 const mock=fakeUI(),first=mock.ui.confirm('Очистить остальные сессии','Переместить 2 неактивные сессии в корзину?'),view=mock.active[0]!;
 assert.match(plain(view).join('\n'),/Очистить остальные сессии[\s\S]*Переместить 2 неактивные сессии в корзину[\s\S]*Отмена[\s\S]*В корзину/);
 assert.equal(mock.options[0].overlay,true);assert.equal(mock.options[0].overlayOptions.anchor,'center');
 view.handleInput('\r');assert.equal(await first,false);
 const second=mock.ui.confirm('Delete session','Move to trash?');mock.active[1]!.handleInput('\x1b[B');mock.active[1]!.handleInput('\r');
 assert.equal(await second,true);assert.equal(mock.closes,2);
});
test('Esc cancels selection, destructive confirmation and text input',async()=>{
 const mock=fakeUI();const a=mock.ui.select('Sort',['First','Second']);mock.active[0]!.handleInput('\x1b');assert.equal(await a,undefined);
 const b=mock.ui.confirm('Delete','Trash?');mock.active[1]!.handleInput('\x1b');assert.equal(await b,false);
 const c=mock.ui.input('Rename','Old');mock.active[2]!.handleInput('\x1b');assert.equal(await c,undefined);
});
test('selector supports keyboard and mouse; frame fits narrow widths',async()=>{
 const mock=fakeUI();const selected=mock.ui.select('Skills',['first','second','third','last '.repeat(28)]);
 for(const row of plain(mock.active[0]!,28))assert.ok(visibleWidth(row)<=28);
 mock.active[0]!.handleInput('\x1b[B');mock.active[0]!.handleInput('\r');assert.equal(await selected,'second');
 const mouse=mock.ui.select('Skills',['first','second','third']);const view=mock.active[1]!;view.render(50);
 const clicked=view.handleMouse?.({type:'click',button:'left',x:5,y:5,width:50,height:10,screenX:5,screenY:5} as any);
 assert.equal(clicked?.handled,true);assert.equal(await mouse,'third');
});
test('text input saves typing and read-only preview scrolls without editing',async()=>{
 const mock=fakeUI(20),pending=mock.ui.input('Rename','Old');for(const key of 'Updated')mock.active[0]!.handleInput(key);mock.active[0]!.handleInput('\r');assert.equal(await pending,'Updated');
 const original=Array.from({length:45},(_,i)=>`detail row ${i+1}`).join('\n'),result=mock.ui.editor('AGENTS.md',original),v=mock.active[1]!;
 assert.match(plain(v).join('\n'),/detail row 1\b/);v.handleInput('\x1b[6~');const after=plain(v).join('\n');assert.doesNotMatch(after,/detail row 1\b/);assert.match(after,/detail row 9\b/);
 v.handleInput('\x1b');assert.equal(await result,undefined);assert.equal(original.split('\n').length,45);
});
test('modal frame fits terminal widths and escapes long titles',()=>{
 for(const width of [8,12,20,38,76]){const f=modalFrame(theme,width,'A very long title with a name',['some extended content'],'Enter select · Esc cancel',true);for(const row of f)assert.ok(visibleWidth(row)<=width,`width ${width}`)}
});

test('read-only preview reuses wrapped content while scrolling and rebuilds on width changes', async () => {
 const mock=fakeUI(40),content=Array.from({length:100},(_,i)=>`CACHE_MARKER_${i} ${'detail '.repeat(20)}`).join('\n');
 const original=Array.prototype.flatMap;
 let wraps=0;
 (Array.prototype as any).flatMap=function(this:unknown[],...args:any[]){
  if(this.length===100&&typeof this[0]==='string'&&this[0].startsWith('CACHE_MARKER_0 '))wraps++;
  return Reflect.apply(original,this,args);
 };
 try {
 const pending=mock.ui.editor('Instructions',content),view=mock.active[0]!;
 view.render(80);
 for(let i=0;i<20;i++){view.handleInput('\x1b[B');view.render(80);}
 assert.equal(wraps,1);
 mock.tui.terminal.rows=25;view.render(80);assert.equal(wraps,1,'height changes reuse wrapped rows');
 const narrow=plain(view,40).join('\n');assert.equal(wraps,2);assert.match(narrow,/CACHE_MARKER_/);
 view.handleInput('\x1b');await pending;
 } finally { Array.prototype.flatMap=original; }
});
