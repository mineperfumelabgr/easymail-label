import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import {PDFDocument} from 'pdf-lib';

const require=createRequire(import.meta.url);
let fontCssPromise;
let rendering=Promise.resolve();
const assets=new Map();
async function imageAsset(url,redirects=0){
  const parsed=new URL(url);
  if(parsed.protocol!=='https:'||parsed.hostname!=='cdn.shopify.com'||parsed.port||redirects>3)throw new Error('Unsupported packing slip image URL');
  const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(15000)});
  if(response.status>=300&&response.status<400)return imageAsset(new URL(response.headers.get('location'),url).href,redirects+1);
  const contentType=response.headers.get('content-type')||'';
  if(!response.ok||!/^image\//i.test(contentType))throw new Error('Packing slip image unavailable');
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>4000000)throw new Error('Packing slip image is too large');chunks.push(chunk);}
  return {status:200,contentType,body:Buffer.concat(chunks)};
}
function cachedAsset(url){
  if(!assets.has(url)){
    if(assets.size>=40)assets.delete(assets.keys().next().value);
    const task=imageAsset(url).then(asset=>{if(asset.body.length>512000)assets.delete(url);return asset;}).catch(error=>{assets.delete(url);throw error;});
    assets.set(url,task);
  }
  return assets.get(url);
}
async function fontCss() {
  return fontCssPromise??= (async()=>{
    const root=path.dirname(require.resolve('@fontsource/noto-sans/400.css'));
    let css='';
    for(const style of ['normal','italic'])for(const weight of [400,700])for(const subset of ['latin','latin-ext','greek','greek-ext','cyrillic','cyrillic-ext']){
      const file=path.join(root,'files',`noto-sans-${subset}-${weight}-${style}.woff2`);
      const bytes=await readFile(file);
      // Separate unicode ranges prevent the Latin font masking Greek/Cyrillic subsets.
      const ranges={latin:'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD','latin-ext':'U+0100-02FF,U+1D00-1DBF,U+1E00-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',greek:'U+0370-03FF','greek-ext':'U+1F00-1FFF',cyrillic:'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116','cyrillic-ext':'U+0460-052F,U+1C80-1C8F,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F'};
      css+=`@font-face{font-family:"Noto Sans";font-style:${style};font-weight:${weight};src:url(data:font/woff2;base64,${bytes.toString('base64')}) format('woff2');unicode-range:${ranges[subset]};}`;
    }
    return css;
  })();
}

export function renderPackingPdfs(htmlDocuments) {
  const task=rendering.then(()=>render(htmlDocuments));
  rendering=task.catch(()=>{});
  return task;
}
async function render(documents) {
  chromium.setGraphicsMode=false;
  const browser=await puppeteer.launch({executablePath:await chromium.executablePath(),args:chromium.args,headless:'shell',pipe:true});
  try{
    const page=await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request',async request=>{
      try{
        const url=new URL(request.url());
        if(url.protocol==='data:')await request.continue();
        else if(request.resourceType()==='image'&&url.protocol==='https:'&&url.hostname==='cdn.shopify.com')await request.respond(await cachedAsset(request.url()));
        else await request.abort();
      }catch{await request.abort().catch(()=>{});}
    });
    await page.setViewport({width:831,height:1175,deviceScaleFactor:1});
    await page.emulateMediaType('print');
    const merged=await PDFDocument.create();
    const fonts=await fontCss();
    const emojiImages=JSON.parse(await readFile(path.resolve('app/templates/packing-emoji.json'),'utf8'));
    for(const document of documents){
      const html=document.replace(/❤️|🎁/gu,emoji=>`<img alt="${emoji}" src="${emojiImages[emoji.replace('️','')]}" style="height:1em;width:1em;vertical-align:-0.15em">`);
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${fonts}\n@page{size:A4}html,body{margin:0;padding:0}body{font-family:"Noto Sans","Noto Color Emoji",sans-serif}.wrapper{font-family:"Noto Sans","Noto Color Emoji",sans-serif!important}</style></head><body>${html}</body></html>`,{waitUntil:'load',timeout:45000});
      // Fonts and images must be ready before the PDF is generated.
      await page.evaluate(async()=>{await document.fonts.ready;});
      const missing=await page.evaluate(()=>[...document.images].some(i=>!i.complete||i.naturalWidth===0));
      if(missing)throw new Error('A packing slip image could not be loaded. Please retry printing.');
      const pdf=await PDFDocument.load(await page.pdf({format:'A4',printBackground:true,scale:0.81,margin:{top:'26pt',right:0,bottom:'26pt',left:0},timeout:45000}));
      const pages=await merged.copyPages(pdf,pdf.getPageIndices());
      pages.forEach(p=>merged.addPage(p));
    }
    return Buffer.from(await merged.save());
  }finally{await browser.close();}
}
