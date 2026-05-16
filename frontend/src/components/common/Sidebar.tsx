import React, { useMemo } from 'react';
import { Tooltip } from 'antd';
import { LayoutGrid, Settings, Puzzle, MessageCircle, ListChecks } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Project, Episode } from '../../types';
import { usePluginStore } from '../../store/pluginStore';
import { useTaskPanelStore } from '../../store/taskPanelStore';
import { AppLogo } from './AppLogo';
import styles from './Sidebar.module.scss';

// 视图类型：支持插件路由
export type AppView = 'projects' | 'overview' | 'editor' | 'settings' | 'plugins' | 'chat' | `plugin:${string}`;

interface SidebarProps {
  view: AppView;
  activeProject: Project | null;
  activeEpisode: Episode | null;
  onViewChange: (view: AppView) => void;
  onConfigChange?: () => void;
}

// 导航项组件
interface NavItemProps {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}

const NavItem: React.FC<NavItemProps> = ({ active, icon, label, onClick }) => (
  <Tooltip title={label} placement="right">
    <button
      onClick={onClick}
      className={[styles.navItem, active ? styles.navItemActive : ''].filter(Boolean).join(' ')}
    >
      {active && (
        <div className={styles.activeIndicator} />
      )}
      <div className={[styles.navIconShell, active ? styles.navIconShellActive : ''].filter(Boolean).join(' ')}>
        {icon}
      </div>
    </button>
  </Tooltip>
);

export const Sidebar: React.FC<SidebarProps> = ({
  view,
  activeProject: _activeProject,
  activeEpisode: _activeEpisode,
  onViewChange,
  onConfigChange: _onConfigChange,
}) => {
  const { t } = useTranslation();
  const plugins = usePluginStore(state => state.plugins);

  const globalPlugins = useMemo(
    () => plugins.filter(p => p.category === 'global' && p.isEnabled),
    [plugins]
  );

  const taskPanelOpen = useTaskPanelStore(s => s.open);
  const toggleTaskPanel = useTaskPanelStore(s => s.toggle);

  const mainNavItems = [
    { key: 'projects', icon: <LayoutGrid size={22} />, label: t('sidebar.projects') },
    { key: 'chat', icon: <MessageCircle size={22} />, label: t('chat.title') },
  ];

  const pluginNavItems = globalPlugins
    .sort((a, b) => (a.globalMeta?.navigation?.order || 50) - (b.globalMeta?.navigation?.order || 50))
    .map(plugin => ({
      key: `plugin:${plugin.id}`,
      icon: <Puzzle size={22} />,
      label: plugin.globalMeta?.navigation?.label || plugin.name,
    }));

  const bottomNavItems = [
    { key: 'settings', icon: <Settings size={22} />, label: t('sidebar.settings') },
  ];

  const handleNavClick = (key: string) => {
    onViewChange(key as AppView);
  };

  return (
    <div className={styles.sidebar}>
      {/* Logo 区域 */}
      <div className="h-14 w-full flex items-center justify-center">
        <AppLogo variant="sidebar" />
      </div>

      {/* 主导航区 */}
      <nav className="flex-1 flex flex-col py-2">
        <div className="space-y-1">
          {mainNavItems.map(item => (
            <NavItem
              key={item.key}
              active={view === item.key}
              icon={item.icon}
              label={item.label}
              onClick={() => handleNavClick(item.key)}
            />
          ))}
          {/* 任务面板入口：点击仅 toggle Drawer，不切 view */}
          <NavItem
            active={taskPanelOpen}
            icon={<ListChecks size={22} />}
            label={t('task.title')}
            onClick={toggleTaskPanel}
          />
        </div>

        {pluginNavItems.length > 0 && (
          <>
            <div className="mx-4 my-3 border-t border-border-subtle" />
            <div className="space-y-1">
              {pluginNavItems.map(item => (
                <NavItem
                  key={item.key}
                  active={view === item.key}
                  icon={item.icon}
                  label={item.label}
                  onClick={() => handleNavClick(item.key)}
                />
              ))}
            </div>
          </>
        )}

        <div className="flex-1" />
        <div className="mx-4 my-3 border-t border-border-subtle" />

        <div className="space-y-1">
          {bottomNavItems.map(item => (
            <NavItem
              key={item.key}
              active={view === item.key}
              icon={item.icon}
              label={item.label}
              onClick={() => handleNavClick(item.key)}
            />
          ))}
        </div>
      </nav>
    </div>
  );
};
