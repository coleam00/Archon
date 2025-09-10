/**
 * Service Registry Context
 *
 * Provides dynamic loading of services and agents from the database
 * instead of static AGENT_CONFIGS definitions.
 */

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import {
  serviceRegistryService,
  ServiceInfo,
} from "../services/serviceRegistryService";
import { useToast } from "./ToastContext";

interface ServiceRegistryContextType {
  // Service data
  services: ServiceInfo[];
  agents: ServiceInfo[];
  backendServices: ServiceInfo[];

  // Loading states
  loading: boolean;
  error: string | null;

  // Methods
  refreshServices: () => Promise<void>;
  getServiceByName: (serviceName: string) => ServiceInfo | undefined;

  // Legacy compatibility helpers
  getAgentConfigs: () => Record<string, ServiceInfo>;
  getAgentsArray: () => ServiceInfo[];
  getServicesArray: () => ServiceInfo[];
}

const ServiceRegistryContext = createContext<ServiceRegistryContextType | null>(
  null
);

export const useServiceRegistry = (): ServiceRegistryContextType => {
  const context = useContext(ServiceRegistryContext);
  if (!context) {
    throw new Error(
      "useServiceRegistry must be used within ServiceRegistryProvider"
    );
  }
  return context;
};

interface ServiceRegistryProviderProps {
  children: React.ReactNode;
}

export const ServiceRegistryProvider: React.FC<
  ServiceRegistryProviderProps
> = ({ children }) => {
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { showToast } = useToast();

  // Derived state
  const agents = services.filter((s) => s.category === "agent");
  const backendServices = services.filter((s) => s.category === "service");

  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  const cancelRef = useRef<(() => void) | null>(null);

  const refreshServices = useCallback(async () => {
    let canceled = false;
    cancelRef.current = () => {
      canceled = true;
    };
    try {
      setLoading(true);
      setError(null);

      // Load all active services from database
      const allServices = await serviceRegistryService.getAllServices(true);
      if (!canceled) setServices(allServices);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to load services";
      if (!canceled) setError(errorMessage);

      // Show toast error, but don't fail completely
      showToastRef.current("Failed to load service registry.", "warning");
    } finally {
      if (!canceled) setLoading(false);
    }
  }, []); // stable via ref

  // Load services on mount
  useEffect(() => {
    refreshServices();
    return () => {
      if (cancelRef.current) cancelRef.current();
    };
  }, [refreshServices]);

  const getServiceByName = useCallback(
    (serviceName: string): ServiceInfo | undefined => {
      return services.find((s) => s.service_name === serviceName);
    },
    [services]
  );

  // Legacy compatibility methods
  const getAgentConfigs = useCallback((): Record<string, ServiceInfo> => {
    const configs: Record<string, ServiceInfo> = {};

    for (const service of services) {
      if (service.category === 'agent') {
        configs[service.service_name] = service;
      }
    }

    return configs;
  }, [services]);

  const getAgentsArray = useCallback((): ServiceInfo[] => {
    return agents;
  }, [agents]);

  const getServicesArray = useCallback((): ServiceInfo[] => {
    return backendServices;
  }, [backendServices]);

  const value: ServiceRegistryContextType = {
    services,
    agents,
    backendServices,
    loading,
    error,
    refreshServices,
    getServiceByName,
    getAgentConfigs,
    getAgentsArray,
    getServicesArray,
  };

  return (
    <ServiceRegistryContext.Provider value={value}>
      {children}
    </ServiceRegistryContext.Provider>
  );
};
