import {redirect} from "react-router";

export function loader({request}) {
  const url=new URL(request.url);
  url.pathname="/app";
  url.searchParams.set("view","tracking");
  return redirect(url.pathname+url.search);
}
