import { AnimatePresence, MotionConfig } from "framer-motion";
import { Route, Routes, useLocation } from "react-router-dom";
import { LandingPage } from "./pages/LandingPage";
import { ProductionDashboardPage } from "./pages/ProductionDashboardPage";
import { AgentPage } from "./pages/AgentPage";

function RoutedApp() {
  const location = useLocation();
  return (
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.pathname}>
        <Route path="/" element={<LandingPage />} />
        <Route path="/app" element={<ProductionDashboardPage />} />
        <Route path="/agent" element={<AgentPage />} />
        <Route path="*" element={<LandingPage />} />
      </Routes>
    </AnimatePresence>
  );
}

export function App() {
  return <MotionConfig reducedMotion="user"><RoutedApp /></MotionConfig>;
}
