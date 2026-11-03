// CSP sandbox действует и при прямом открытии URL, не только внутри iframe.
export const VIEW_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

export function isolatedView(html, data, dataUrl) {
  const safe = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  // Старые виды используют fetch(DATA_URL). Вместо сети отдаём разрешённый снимок.
  const bridge = `<script>(function(){
    var url=${safe(dataUrl)}, snapshot=${safe(JSON.stringify(data))};
    Object.defineProperty(window,"fetch",{configurable:false,writable:false,value:function(input,options){
      var target, method=String((options&&options.method)||(input&&input.method)||"GET").toUpperCase();
      try { target=new URL(typeof input==="string"||input instanceof URL?String(input):input.url,url).href; } catch(e){ return Promise.reject(new TypeError("Недопустимый адрес данных")); }
      if(target!==url||method!=="GET") return Promise.reject(new TypeError("Вид может читать только данные своего раздела"));
      return Promise.resolve(new Response(snapshot,{status:200,headers:{"content-type":"application/json"}}));
    }});
  })();</script>`;
  return "<!doctype html>" + bridge + html.replace(/^\s*<!doctype html[^>]*>/i, "");
}
