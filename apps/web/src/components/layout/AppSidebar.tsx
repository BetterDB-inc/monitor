import { useLocation } from 'react-router-dom';
import { useCapabilities } from '../../hooks/useCapabilities';
import { ConnectionSelector } from '../ConnectionSelector';
import { ModeToggle } from '../ModeToggle';
import { CloudUser } from '../../api/workspace';
import { NavItem } from './NavItem';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarSeparator,
} from '@/components/ui/sidebar.tsx';
import { Feature } from '@betterdb/shared';
import { CommunityBanner } from '@/components/layout/CommunityBanner.tsx';

interface SidebarProps {
  cloudUser: CloudUser | null;
  onFeedbackClick: () => void;
}

export function AppSidebar({ cloudUser, onFeedbackClick }: SidebarProps) {
  const location = useLocation();
  const { hasVectorSearch } = useCapabilities();

  return (
    <Sidebar className="bg-card">
      <SidebarHeader>
        <div className="p-4 pb-2">
          <h2 className="text-lg font-semibold">BetterDB Monitor</h2>
        </div>
        <div className=" mb-1">
          <ConnectionSelector isCloudMode={!!cloudUser} />
        </div>
      </SidebarHeader>
      <SidebarSeparator className="mb-2 mx-0" />
      <SidebarContent>
        <nav className="space-y-1 px-3 flex-1">
          <NavItem to="/" active={location.pathname === '/'}>
            Dashboard
          </NavItem>
          <NavItem to="/slowlog" active={location.pathname === '/slowlog'}>
            Slow Log
          </NavItem>
          <NavItem to="/latency" active={location.pathname === '/latency'}>
            Latency
          </NavItem>
          <NavItem to="/clients" active={location.pathname === '/clients'}>
            Clients
          </NavItem>
          <NavItem to="/client-analytics" active={location.pathname === '/client-analytics'}>
            Client Analytics
          </NavItem>
          <NavItem
            to="/client-analytics/deep-dive"
            active={location.pathname === '/client-analytics/deep-dive'}
          >
            Analytics Deep Dive
          </NavItem>
          <NavItem to="/cluster" active={location.pathname === '/cluster'}>
            Cluster
          </NavItem>
          <NavItem to="/forecasting" active={location.pathname === '/forecasting'}>
            Forecasting
          </NavItem>
          <NavItem
            to="/anomalies"
            active={location.pathname === '/anomalies'}
            requiredFeature={Feature.ANOMALY_DETECTION}
          >
            Anomaly Detection
          </NavItem>
          <NavItem
            to="/key-analytics"
            active={location.pathname === '/key-analytics'}
            requiredFeature={Feature.KEY_ANALYTICS}
          >
            Key Analytics
          </NavItem>
          {hasVectorSearch && (
            <NavItem to="/vector-search" active={location.pathname === '/vector-search'}>
              Vector Search
            </NavItem>
          )}
          {hasVectorSearch && (
            <NavItem to="/vector-ai" active={location.pathname === '/vector-ai'}>
              Vector / AI
            </NavItem>
          )}
          {hasVectorSearch && (
            <NavItem
              to="/inference-latency"
              active={location.pathname === '/inference-latency'}
            >
              Inference Latency
            </NavItem>
          )}
          <NavItem to="/audit" active={location.pathname === '/audit'}>
            Audit Trail
          </NavItem>
          <NavItem to="/webhooks" active={location.pathname === '/webhooks'}>
            Webhooks
          </NavItem>
          <NavItem to="/migration" active={location.pathname === '/migration'}>
            Migration
          </NavItem>
          {!cloudUser && (
            <NavItem to="/helper" active={location.pathname === '/helper'}>
              <span className="flex items-center justify-between w-full">
                AI Helper
                <span className="text-[10px] px-1.5 py-0.5 bg-amber-500 text-amber-950 rounded font-medium">
                  Experimental
                </span>
              </span>
            </NavItem>
          )}
        </nav>
        <CommunityBanner />
      </SidebarContent>
      <SidebarFooter className="p-0 gap-1">
        <div className="px-3 pb-4 border-t border-border pt-2 space-y-1">
          <ModeToggle />
          <a
            href="https://docs.betterdb.com"
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted"
          >
            Documentation
          </a>
          <button
            onClick={onFeedbackClick}
            className="block w-full text-left rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted"
          >
            Feedback
          </button>
          {cloudUser && (
            <NavItem to="/workspace/members" active={location.pathname === '/workspace/members'}>
              Team
            </NavItem>
          )}
          <NavItem to="/settings" active={location.pathname === '/settings'}>
            Settings
          </NavItem>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
