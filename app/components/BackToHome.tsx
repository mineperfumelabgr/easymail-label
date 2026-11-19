import {Link,useLocation,useSearchParams} from 'react-router';
import '../styles/navigation.css';

export function BackToHome(){
  const {pathname}=useLocation();
  const [params]=useSearchParams();
  if(pathname.replace(/\/+$/,'')==='/app')return null;
  const context=new URLSearchParams([...params].filter(([key])=>['shop','host','embedded'].includes(key)));
  const home='/app'+(context.size?'?'+context:'');
  return <nav className="courier-return-nav" aria-label="Page navigation"><Link to={home} className="courier-home-button"><span aria-hidden="true">←</span> Back to home</Link></nav>;
}
