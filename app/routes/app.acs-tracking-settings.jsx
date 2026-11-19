import {useLoaderData} from "react-router";
import {AcsTagSettingsPanel} from "../components/AcsTagSettingsPanel";
import {loadAcsTagSettings,handleAcsTagSettings} from "../services/acs-tag-settings.server";
import "../styles/courier.css";
export const loader=loadAcsTagSettings;
export const action=handleAcsTagSettings;
export default function AcsTrackingSettings(){const {rules,shop}=useLoaderData();return <main className="courier operations"><h1>ACS Operations</h1><AcsTagSettingsPanel initialRules={rules} shop={shop}/></main>;}
