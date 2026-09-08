// One material vocabulary, composed from reusable shapes. The provider mapping
// stays in Desktop's weatherFor(); these are an optional visual treatment.
let serial = 0
export function softWeatherIcon(icon, label, id=`weather-${++serial}`) {
  const n=id.replace(/[^a-zA-Z0-9_-]/g,'')
  const ref=s=>`${n}-${s}`
  const cloud=(x=0,y=0,scale=1,back=false)=>`<g transform="translate(${x} ${y}) scale(${scale})" opacity="${back ? .66 : 1}" filter="url(#${ref('shadow')})"><path d="M44 97c-14 0-23-8-23-19 0-10 7-18 17-20 2-17 14-29 31-29 16 0 28 10 32 24 3-1 6-2 10-2 17 0 29 11 29 25 0 13-10 21-25 21Z" fill="url(#${ref('cloud')})" stroke="url(#${ref('edge')})" stroke-width="1.2"/><path d="M41 62c3-16 13-27 29-27 10 0 20 5 25 14" fill="none" stroke="#fff" stroke-opacity=".72" stroke-width="1.7" stroke-linecap="round"/></g>`
  const sun=(x=101,y=47,r=26)=>`<g><circle cx="${x}" cy="${y}" r="${r+15}" fill="url(#${ref('halo')})"/><circle cx="${x}" cy="${y}" r="${r}" fill="url(#${ref('sun')})" stroke="#fffbed" stroke-opacity=".8"/><path d="M${x-r*.65} ${y-r*.35}a${r*.73} ${r*.73} 0 0 1 ${r*.85} -${r*.37}" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="1.5" stroke-linecap="round"/></g>`
  const moon=(x=80,y=58,r=31)=>`<g transform="translate(${x-80} ${y-58})" filter="url(#${ref('shadow')})"><path d="M${80+r*.64} ${58-r*.79}a${r} ${r} 0 1 0 ${r*.18} ${r*1.39}a${r*.91} ${r*.91} 0 0 1 -${r*.18} -${r*1.39}Z" fill="url(#${ref('moon')})" stroke="#ffffffab" stroke-width="1"/><circle cx="120" cy="40" r="1.7" fill="#fff"/><circle cx="129" cy="63" r="1.2" fill="#fff"/></g>`
  const drops=(light=false)=>`<g stroke="#799caf" stroke-width="${light?2.5:4}" stroke-linecap="round" opacity=".86">${[48,77,106].map((x,i)=>`<path d="M${x} ${107+(i%2)*5}l-${light?2:4} ${light?5:10}"/>`).join('')}</g>`
  const snow=()=>`<g stroke="#9ab3c0" stroke-width="1.8" stroke-linecap="round">${[48,79,110].map((x,i)=>`<path d="M${x} ${108+i%2*8}v10m-4.3-7.5 8.6 5m-8.6 0 8.6-5"/>`).join('')}</g>`
  const ice=()=>`<g fill="url(#${ref('moon')})" stroke="#99b6c5" stroke-width=".65">${[50,81,109].map((x,i)=>`<circle cx="${x}" cy="${112+i%2*8}" r="3.4"/>`).join('')}</g>`
  const lightning=`<path d="M83 89 67 111h13l-6 20 24-28H84l9-14Z" fill="url(#${ref('bolt')})" stroke="#fff8d788" stroke-width=".7" filter="url(#${ref('shadow')})"/>`
  let body=''
  if(icon==='clear-day')body=sun(80,68,33)
  else if(icon==='clear-night')body=moon()
  else if(icon==='partly-cloudy-day')body=sun(101,45,25)+cloud(1,26,.88)
  else if(icon==='partly-cloudy-night')body=moon(100,48,27)+cloud(1,27,.88)
  else if(icon==='overcast')body=cloud(23,0,.75,true)+cloud(0,24,.94)
  else if(icon==='fog')body=cloud(10,9,.87)+`<g stroke="#a2b5c0" stroke-width="3" stroke-linecap="round" opacity=".56"><path d="M33 109h57m10 0h20M43 119h63"/></g>`
  else if(icon==='rain'||icon==='drizzle')body=cloud(6,4,.92)+drops(icon==='drizzle')
  else if(icon==='snow')body=cloud(6,4,.92)+snow()
  else if(icon==='sleet')body=cloud(6,4,.92)+drops(true)+`<g fill="#b8cad2"><circle cx="60" cy="122" r="2.7"/><circle cx="95" cy="123" r="2.7"/></g>`
  else if(icon==='thunderstorms'||icon==='thunderstorms-hail')body=cloud(23,-6,.72,true)+cloud(1,4,.93)+lightning+(icon==='thunderstorms-hail'?ice():'')
  else body=`<circle cx="80" cy="70" r="27" fill="url(#${ref('cloud')})" stroke="#c5d0d8"/><path d="M68 70h24" stroke="#a2b5c0" stroke-width="3" stroke-linecap="round"/>`
  return `<svg class="soft-weather-icon condition-icon" viewBox="0 0 160 144" role="img" aria-label="${String(label).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}"><defs><radialGradient id="${ref('sun')}" cx="35%" cy="25%" r="90%"><stop stop-color="#fffef3"/><stop offset=".65" stop-color="#fff6d1"/><stop offset="1" stop-color="#e7cf97"/></radialGradient><radialGradient id="${ref('halo')}"><stop stop-color="#fff8d6" stop-opacity=".75"/><stop offset="1" stop-color="#fff8d6" stop-opacity="0"/></radialGradient><linearGradient id="${ref('cloud')}" x1=".3" y1="0" x2=".65" y2="1" gradientUnits="objectBoundingBox"><stop stop-color="#fff" stop-opacity=".98"/><stop offset=".48" stop-color="#f7fbfd" stop-opacity=".91"/><stop offset="1" stop-color="#c9dce7" stop-opacity=".84"/></linearGradient><linearGradient id="${ref('edge')}" x2="0" y2="1"><stop stop-color="#fff" stop-opacity=".96"/><stop offset="1" stop-color="#fff" stop-opacity=".16"/></linearGradient><linearGradient id="${ref('moon')}" x2=".7" y2="1"><stop stop-color="#fff"/><stop offset="1" stop-color="#aec7df"/></linearGradient><linearGradient id="${ref('bolt')}" x2=".7" y2="1"><stop stop-color="#fff4c2"/><stop offset="1" stop-color="#dcb873"/></linearGradient><filter id="${ref('shadow')}" x="-35%" y="-40%" width="180%" height="190%"><feDropShadow dx="0" dy="6" stdDeviation="4" flood-color="#456578" flood-opacity=".14"/></filter></defs>${body}</svg>`
}
