import { useLocation } from 'react-router-dom';
import { useIsDemo } from '../../contexts/DemoContext';
import { useCanMutate } from '../../hooks/useCanMutate';
import { useCapabilities } from '../../hooks/useCapabilities';
import { useCacheProposalsUnread } from '../../hooks/useCacheProposals';
import { ConnectionSelector } from '../ConnectionSelector';
import { CloudUser } from '../../api/workspace';
import { NavItem } from './NavItem';
import { SidebarUserMenu } from './SidebarUserMenu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarSeparator,
} from '@/components/ui/sidebar.tsx';
import { Feature } from '@betterdb/shared';
import { CommunityBanner } from '@/components/layout/CommunityBanner.tsx';
import { ExternalLink } from 'lucide-react';

interface SidebarProps {
  cloudUser: CloudUser | null;
  onFeedbackClick: () => void;
  onShortcutsClick: () => void;
}

export function AppSidebar({ cloudUser, onFeedbackClick, onShortcutsClick }: SidebarProps) {
  const location = useLocation();
  const { hasVectorSearch } = useCapabilities();
  const { unreadCount: cacheProposalsUnread } = useCacheProposalsUnread();
  const isDemo = useIsDemo();
  const canMutate = useCanMutate();

  return (
    <Sidebar className="bg-card">
      <SidebarHeader>
        <div className="p-4 pb-2 flex items-center gap-2">
          <img
            src="/symbol-white.svg"
            alt=""
            aria-hidden="true"
            className="h-8 w-8 shrink-0 rounded-md bg-primary p-1"
          />
          <h2 className="text-lg font-semibold">BetterDB Monitor</h2>
        </div>
        <div className=" mb-1">
          <ConnectionSelector isCloudMode={!!cloudUser} />
        </div>
      </SidebarHeader>
      <SidebarSeparator className="mb-2 mx-0" />
      <SidebarContent>
        <nav className="space-y-1 px-3 flex-1" aria-label="Primary">
          <NavItem to="/" active={location.pathname === '/'}>
            Dashboard
          </NavItem>
          <NavItem to="/fleet" active={location.pathname === '/fleet'}>
            Fleet
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
          <NavItem
            to="/bulk-delete"
            active={location.pathname === '/bulk-delete'}
            requiredFeature={Feature.BULK_DELETE}
            demoLocked={isDemo}
            locked={canMutate === false}
            lockedReason="Admins only"
          >
            Bulk Delete
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
          <NavItem to="/ai-cache-memory" active={location.pathname === '/ai-cache-memory'}>
            AI Cache &amp; Memory
          </NavItem>
          <NavItem to="/ai-traces" active={location.pathname === '/ai-traces'}>
            AI Traces
          </NavItem>
          {hasVectorSearch && (
            <NavItem to="/inference-latency" active={location.pathname === '/inference-latency'}>
              Inference Latency
            </NavItem>
          )}
          <NavItem to="/security" active={location.pathname === '/security'}>
            Security
          </NavItem>
          <NavItem to="/audit" active={location.pathname === '/audit'}>
            Audit Trail
          </NavItem>
          <NavItem to="/monitor" active={location.pathname === '/monitor'}>
            MONITOR
          </NavItem>
          <NavItem
            to="/webhooks"
            active={location.pathname === '/webhooks'}
            demoLocked={isDemo}
            locked={canMutate === false}
            lockedReason="Admins only"
          >
            Webhooks
          </NavItem>
          <NavItem to="/migration" active={location.pathname === '/migration'}>
            Migration
          </NavItem>
          <NavItem
            to="/cache-proposals"
            active={location.pathname === '/cache-proposals'}
            requiredFeature={Feature.CACHE_INTELLIGENCE}
          >
            <span className="flex items-center justify-between w-full">
              Cache Proposals
              {cacheProposalsUnread > 0 && (
                <span
                  data-testid="cache-proposals-unread-badge"
                  className="ml-2 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-primary text-primary-foreground text-[10px] font-semibold"
                >
                  {cacheProposalsUnread > 99 ? '99+' : cacheProposalsUnread}
                </span>
              )}
            </span>
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
          <a
            href="https://docs.betterdb.com"
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted"
          >
            Documentation
            <ExternalLink aria-hidden="true" className="size-3.5 text-muted-foreground" />
          </a>
          <button
            type="button"
            onClick={onFeedbackClick}
            className="block w-full text-left rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted"
          >
            Feedback
          </button>
          <NavItem to="/settings" active={location.pathname === '/settings'} demoLocked={isDemo}>
            Settings
          </NavItem>
          <SidebarUserMenu onShortcutsClick={onShortcutsClick} />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
