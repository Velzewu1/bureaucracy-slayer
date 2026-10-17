import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { HelpFaq } from "./pages/HelpFaq";
import { HelpIndex } from "./pages/HelpIndex";
import { HelpInstantTransfers } from "./pages/HelpInstantTransfers";
import { HelpRecovery } from "./pages/HelpRecovery";
import { HelpTransfers } from "./pages/HelpTransfers";
import { HelpUnauthorized } from "./pages/HelpUnauthorized";
import { NotFound } from "./pages/NotFound";
import { Support } from "./pages/Support";
import { TestLab } from "./pages/TestLab";
import { TransferDetail } from "./pages/TransferDetail";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/transfers/:transferId" element={<TransferDetail />} />
        <Route path="/help" element={<HelpIndex />} />
        <Route path="/help/transfers" element={<HelpTransfers />} />
        <Route path="/help/instant-transfers" element={<HelpInstantTransfers />} />
        <Route path="/help/recovery" element={<HelpRecovery />} />
        <Route path="/help/unauthorized-transfers" element={<HelpUnauthorized />} />
        <Route path="/help/faq" element={<HelpFaq />} />
        <Route path="/support" element={<Support />} />
        {/* Test harness only. Deliberately not linked from any portal page. */}
        <Route path="/test-lab" element={<TestLab />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
