import {useLoaderData} from "react-router";
import {AcsManualShipmentPanel} from "../components/AcsManualShipmentPanel";
import {loadAcsManualShipments,handleAcsManualShipment} from "../services/acs-manual-shipments.server";
import "../styles/courier.css";
export const loader=loadAcsManualShipments;
export const action=handleAcsManualShipment;
export default function CustomAcsShipmentPage(){const {shipments}=useLoaderData();return <main className="courier operations"><h1>ACS manual shipments</h1><AcsManualShipmentPanel shipments={shipments}/></main>;}
