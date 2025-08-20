import { useState, useEffect, useRef, memo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Database,
  Copy,
  ExternalLink,
  CheckCircle,
  AlertCircle,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import {
  databaseService,
  type DatabaseStatus,
  type SetupSQLResponse,
} from '../../services/databaseService';
import { DatabaseError } from '../../types/errors';
import { useToast } from '../../contexts/ToastContext';
import { createLogger } from '../../utils/logger';

/**
 * Props for the DatabaseSetupStep component
 */
interface DatabaseSetupStepProps {
  onComplete: () => void;
  onSkip?: () => void;
}

/**
 * Database setup step component for onboarding flow
 *
 * Guides users through the database initialization process, including:
 * - Checking current database status
 * - Providing SQL setup scripts
 * - Auto-verification with polling
 * - Direct links to Supabase SQL editor
 */
const DatabaseSetupStepComponent = ({
  onComplete,
  onSkip,
}: DatabaseSetupStepProps) => {
  const [status, setStatus] = useState<DatabaseStatus | null>(null);
  const [setupData, setSetupData] = useState<SetupSQLResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoVerifying, setAutoVerifying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step1Completed, setStep1Completed] = useState(false);
  const [step1Animating, setStep1Animating] = useState(false);
  const [step2Completed, setStep2Completed] = useState(false);
  const [step2Animating, setStep2Animating] = useState(false);
  const [pollingTimeoutReached, setPollingTimeoutReached] = useState(false);
  const [checkingManually, setCheckingManually] = useState(false);
  const [buttonState, setButtonState] = useState<'default' | 'failed'>(
    'default'
  );
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const pollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const animationTimeoutRefs = useRef<Set<NodeJS.Timeout>>(new Set());
  const onCompleteRef = useRef(onComplete);
  const { showToast } = useToast();
  const logger = createLogger('DatabaseSetupStep');

  useEffect(() => {
    onCompleteRef.current = onComplete;
  });
  const checkDatabaseStatus = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const dbStatus = await databaseService.getStatus();
      setStatus(dbStatus);

      if (dbStatus.setup_required) {
        const sqlData = await databaseService.getSetupSQL();
        setSetupData(sqlData);
      } else {
        onCompleteRef.current();
        return;
      }
    } catch (err) {
      if (err instanceof DatabaseError) {
        let errorMessage = '';
        
        if (err.code === 'DATABASE_CONNECTION_ERROR') {
          errorMessage = 'Unable to connect to your Supabase database. Please check:';
          errorMessage += '\n\n• Supabase URL and Service Key are correct';
          errorMessage += '\n• Your Supabase project is active and running';
          errorMessage += '\n• Network connectivity to Supabase';
          
          if (err.context.serverContext?.supabase_url?.includes('localhost') || 
              err.context.serverContext?.supabase_url?.includes('127.0.0.1')) {
            errorMessage += '\n\nNote: You\'re using a local Supabase URL. Make sure:';
            errorMessage += '\n• Local Supabase is running (supabase start)';
            errorMessage += '\n• URL uses host.docker.internal instead of localhost for Docker';
          }
        } else {
          errorMessage = `${err.message}`;
          if (err.remediation) {
            errorMessage += `\n\nSuggested Fix: ${err.remediation}`;
          }
        }
        
        errorMessage += `\n\nError Code: ${err.code}`;
        if (err.context.correlationId) {
          errorMessage += `\nCorrelation ID: ${err.context.correlationId}`;
        }

        setError(errorMessage);

        console.error('Database setup error details:', {
          error: err.toJSON(),
          timestamp: new Date().toISOString(),
          userAgent: navigator.userAgent,
          url: window.location.href,
        });
      } else {
        setError(
          `Unexpected error: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        logger.error('Unexpected database setup error', {
          error: err instanceof Error ? err.message : String(err),
          errorType: err instanceof Error ? err.constructor.name : typeof err,
        });
      }
    } finally {
      const loadingTimeout = setTimeout(() => {
        setLoading(false);
      }, 1200);
      animationTimeoutRefs.current.add(loadingTimeout);
    }
  }, [logger]);

  const startAutoVerification = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }

    setAutoVerifying(true);
    setPollingTimeoutReached(false);
    setError(null);

    const timeoutMs = import.meta.env.VITE_DB_SETUP_TIMEOUT_MS
      ? parseInt(import.meta.env.VITE_DB_SETUP_TIMEOUT_MS)
      : 180000;

    pollTimeoutRef.current = setTimeout(() => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      setAutoVerifying(false);
      setPollingTimeoutReached(true);
    }, timeoutMs);

    pollIntervalRef.current = setInterval(async () => {
      try {
        const result = await databaseService.verifySetup();

        if (result.success) {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          if (pollTimeoutRef.current) {
            clearTimeout(pollTimeoutRef.current);
            pollTimeoutRef.current = null;
          }
          onCompleteRef.current();
        }
      } catch (err) {
        console.error('Auto-verification polling failed:', err);
      }
    }, 3000);
  }, []);

  useEffect(() => {
    setPollingTimeoutReached(false);
    checkDatabaseStatus();
    const timeoutsSet = animationTimeoutRefs.current;
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
      timeoutsSet.forEach(timeoutId => {
        clearTimeout(timeoutId);
      });
      timeoutsSet.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // only run on mount/unmount

  useEffect(() => {
    if (
      status?.setup_required &&
      !loading &&
      !autoVerifying &&
      !pollingTimeoutReached
    ) {
      startAutoVerification();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.setup_required, loading, autoVerifying, pollingTimeoutReached]); // No startAutoVerification

  const copyToClipboard = async () => {
    if (!setupData?.sql_content) return;

    try {
      await navigator.clipboard.writeText(setupData.sql_content);
      setCopied(true);

      if (!step1Completed) {
        setStep1Completed(true);
        setStep1Animating(true);

        const animationTimeout = setTimeout(() => {
          setStep1Animating(false);
        }, 800);
        animationTimeoutRefs.current.add(animationTimeout);
      }

      const copiedTimeout = setTimeout(() => setCopied(false), 2000);
      animationTimeoutRefs.current.add(copiedTimeout);
    } catch (err) {
      console.error('Failed to copy SQL to clipboard:', err);
      showToast(
        'Failed to copy SQL to clipboard. Please select and copy the text manually.',
        'error'
      );
    }
  };

  const openSqlEditor = () => {
    if (setupData?.sql_editor_url) {
      window.open(setupData.sql_editor_url, '_blank');

      if (!step2Completed) {
        setStep2Completed(true);
        setStep2Animating(true);

        const animationTimeout = setTimeout(() => {
          setStep2Animating(false);
        }, 800);
        animationTimeoutRefs.current.add(animationTimeout);
      }
    }
  };

  const verifySetup = async () => {
    try {
      setError(null);

      const result = await databaseService.verifySetup();

      if (result.success) {
        onCompleteRef.current();
      } else {
        setError(result.message);
      }
    } catch (err) {
      if (err instanceof DatabaseError) {
        let errorMessage = '';
        
        if (err.code === 'DATABASE_CONNECTION_ERROR') {
          errorMessage = 'Database connection failed during verification. Please ensure:';
          errorMessage += '\n\n• Your Supabase credentials are valid';
          errorMessage += '\n• The database is accessible';
          errorMessage += '\n• You have run the setup SQL correctly';
        } else {
          errorMessage = `${err.message}`;
          if (err.remediation) {
            errorMessage += `\n\nSuggested Fix: ${err.remediation}`;
          }
        }
        
        errorMessage += `\n\nError Code: ${err.code}`;
        setError(errorMessage);

        console.error('Database verification error:', err.toJSON());
      } else {
        setError(err instanceof Error ? err.message : 'Failed to verify setup');
        console.error('Unexpected verification error:', err);
      }
    }
  };

  const manualCheck = async () => {
    try {
      setCheckingManually(true);
      setError(null);

      const result = await databaseService.verifySetup();

      if (result.success) {
        onCompleteRef.current();
      } else {
        setButtonState('failed');
        const failedTimeout = setTimeout(() => {
          setButtonState('default');
        }, 1200);
        animationTimeoutRefs.current.add(failedTimeout);
      }
    } catch (err) {
      setButtonState('failed');
      const failedTimeout = setTimeout(() => {
        setButtonState('default');
      }, 1200);
      animationTimeoutRefs.current.add(failedTimeout);
    } finally {
      const checkingTimeout = setTimeout(() => {
        setCheckingManually(false);
      }, 800);
      animationTimeoutRefs.current.add(checkingTimeout);
    }
  };

  const StepIndicator = memo(
    ({
      stepNumber,
      isCompleted,
      isAnimating,
    }: {
      stepNumber: number;
      isCompleted: boolean;
      isAnimating: boolean;
    }) => {
      if (isAnimating) {
        return (
          <motion.div
            key={`animating-${stepNumber}`}
            className='w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 text-white rounded-full flex items-center justify-center text-sm font-bold mr-3 shadow-sm shadow-grey-500/30'
            animate={{
              scale: [1, 1.3, 1],
              boxShadow: [
                '0 0 0px rgba(59, 130, 246, 0)',
                '0 0 20px rgba(59, 130, 246, 0.6)',
                '0 0 0px rgba(59, 130, 246, 0)',
              ],
            }}
            transition={{
              duration: 0.8,
              ease: 'easeInOut',
            }}>
            <AnimatePresence mode='wait'>
              <motion.div
                key={isCompleted ? 'check' : 'number'}
                initial={{ opacity: 0, scale: 0.3 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.3 }}
                transition={{
                  duration: 0.4,
                  ease: 'backOut',
                }}>
                {isCompleted ? <CheckCircle className='w-4 h-4' /> : stepNumber}
              </motion.div>
            </AnimatePresence>
          </motion.div>
        );
      }

      return (
        <div
          key={`static-${stepNumber}`}
          className='w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 text-white rounded-full flex items-center justify-center text-sm font-bold mr-3 shadow-sm shadow-blue-500/30'>
          {isCompleted ? <CheckCircle className='w-4 h-4' /> : stepNumber}
        </div>
      );
    }
  );

  StepIndicator.displayName = 'StepIndicator';

  if (loading) {
    return (
      <Card className='p-12 !transition-none'>
        <div className='flex items-center justify-between mb-6'>
          <div className='flex items-center'>
            <div className='w-12 h-12 rounded-full bg-gradient-to-br from-blue-500 to-cyan-600 flex items-center justify-center mr-4'>
              <div className='relative w-6 h-6'>
                <Database className='w-6 h-6 text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-cyan-300' />
                <div className='absolute inset-0 blur-sm bg-gradient-to-r from-blue-400 to-cyan-300 opacity-50 -z-10'></div>
              </div>
            </div>
            <h2 className='text-2xl font-bold text-gray-800 dark:text-white'>
              Initialize Database
            </h2>
          </div>
          {setupData?.project_id && (
            <div className='text-sm text-gray-400 dark:text-zinc-500'>
              <span className='font-semibold'>Project ID:</span>{' '}
              {setupData.project_id}
            </div>
          )}
        </div>

        <div className='space-y-4 mb-6'>
          <div className='flex items-center p-3 bg-gray-50 dark:bg-zinc-800 rounded-lg opacity-0 pointer-events-none'>
            <div className='w-8 h-8 rounded-full mr-3 flex-shrink-0'></div>
            <span className='flex-1 min-w-0'>Copy the setup SQL</span>
            <div className='w-20 h-8 flex-shrink-0'></div>
          </div>

          <div className='flex items-center p-3 bg-gray-50 dark:bg-zinc-800 rounded-lg opacity-0 pointer-events-none'>
            <div className='w-8 h-8 rounded-full mr-3 flex-shrink-0'></div>
            <span className='flex-1 min-w-0'>
              Paste and Run the SQL in Supabase SQL Editor
            </span>
            <div className='w-24 h-8 flex-shrink-0'></div>
          </div>

          <div className='flex items-center p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg opacity-0 pointer-events-none'>
            <div className='w-8 h-8 rounded-full mr-3 flex-shrink-0'></div>
            <div className='flex-1 min-w-0'>
              Waiting for you to run the SQL...
            </div>
          </div>
        </div>

        <div className='absolute inset-0 flex items-center justify-center'>
          <div className='text-center'>
            <div className='w-16 h-16 rounded-full bg-gradient-to-br from-blue-500 to-cyan-600 flex items-center justify-center mx-auto mb-4'>
              <Loader2 className='w-8 h-8 text-white animate-spin' />
            </div>
            <p className='text-gray-600 dark:text-zinc-400'>
              Checking your database configuration...
            </p>
          </div>
        </div>

        <div className='flex justify-end'>
          <Button
            variant='primary'
            disabled
            className='cursor-not-allowed opacity-50'>
            Next
          </Button>
        </div>
      </Card>
    );
  }

  if (
    status?.message?.includes('environment variables') ||
    error?.includes('environment variables')
  ) {
    return (
      <Card className='p-12'>
        <div className='flex items-center justify-between mb-6'>
          <div className='flex items-center'>
            <div className='w-12 h-12 rounded-full bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center mr-4'>
              <AlertCircle className='w-6 h-6 text-white' />
            </div>
            <h2 className='text-2xl font-bold text-gray-800 dark:text-white'>
              Supabase Configuration Required
            </h2>
          </div>
        </div>

        <div className='bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg p-6 mb-6'>
          <div className='flex items-start'>
            <AlertCircle className='w-5 h-5 text-orange-600 dark:text-orange-400 mt-0.5 mr-3 flex-shrink-0' />
            <div>
              <h3 className='font-semibold text-orange-800 dark:text-orange-200 mb-2'>
                Environment Variables Missing
              </h3>
              <p className='text-orange-700 dark:text-orange-300 mb-4'>
                Please add the following environment variables to your{' '}
                <code className='bg-orange-100 dark:bg-orange-800 px-1 py-0.5 rounded text-sm'>
                  .env
                </code>{' '}
                file:
              </p>
              <div className='bg-gray-900 text-green-400 p-4 rounded-md font-mono text-sm mb-4'>
                <div>SUPABASE_URL=https://your-project-id.supabase.co</div>
                <div>SUPABASE_SERVICE_KEY=your-service-key-here</div>
              </div>
              <p className='text-orange-700 dark:text-orange-300 mb-4'>
                Then run:
              </p>
              <div className='bg-gray-900 text-green-400 p-4 rounded-md font-mono text-sm mb-4'>
                <code>docker-compose down && docker-compose up -d</code>
              </div>
              <p className='text-orange-700 dark:text-orange-300 mb-4'>
                You can find these values in your{' '}
                <a
                  href='https://supabase.com/dashboard'
                  target='_blank'
                  rel='noopener noreferrer'
                  className='text-orange-800 dark:text-orange-200 underline hover:no-underline'>
                  Supabase Dashboard
                </a>{' '}
                in Settings → API.
              </p>
            </div>
          </div>
        </div>

        <div className='flex justify-end my-2'>
          <div className='text-sm text-gray-400 dark:text-zinc-600 cursor-not-allowed'>
            Database configuration is required to continue
          </div>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className='p-12'>
        <div className='flex items-center justify-between mb-6'>
          <div className='flex items-center'>
            <div className='w-12 h-12 rounded-full bg-gradient-to-br from-red-500 to-orange-600 flex items-center justify-center mr-4'>
              <AlertCircle className='w-6 h-6 text-white' />
            </div>
            <h2 className='text-2xl font-bold text-gray-800 dark:text-white'>
              Database Connection Error
            </h2>
          </div>
        </div>

        <div className='bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6 mb-6'>
          <div className='flex items-start'>
            <AlertCircle className='w-5 h-5 text-red-600 dark:text-red-400 mt-0.5 mr-3 flex-shrink-0' />
            <div className='flex-1'>
              <pre className='text-red-700 dark:text-red-300 whitespace-pre-wrap font-sans text-sm leading-relaxed'>
                {error}
              </pre>
            </div>
          </div>
        </div>

        <div className='flex gap-4 justify-center'>
          <Button variant='outline' onClick={checkDatabaseStatus}>
            <RefreshCw className='w-4 h-4 mr-2' />
            Retry Connection
          </Button>
          {onSkip && (
            <Button variant='secondary' onClick={onSkip}>
              Skip for now
            </Button>
          )}
        </div>
      </Card>
    );
  }

  if (!status?.setup_required) {
    return (
      <Card className='p-12 text-center'>
        <div className='flex justify-center mb-6'>
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 260, damping: 20 }}
            className='w-20 h-20 rounded-full bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center'>
            <CheckCircle className='w-10 h-10 text-white' />
          </motion.div>
        </div>

        <h2 className='text-3xl font-bold text-gray-800 dark:text-white mb-4'>
          Database Ready!
        </h2>

        <p className='text-lg text-gray-600 dark:text-zinc-400 max-w-md mx-auto'>
          Your database is properly initialized and ready to use.
        </p>
      </Card>
    );
  }

  return (
    <Card className='p-12'>
      <div className='flex items-center justify-between mb-6'>
        <div className='flex items-center'>
          <div className='w-12 h-12 rounded-full bg-gradient-to-br from-blue-500 to-cyan-600 flex items-center justify-center mr-4'>
            <Database className='w-6 h-6 text-white' />
          </div>
          <h2 className='text-2xl font-bold text-gray-800 dark:text-white'>
            Initialize Database
          </h2>
        </div>
        {setupData?.project_id && (
          <div className='text-sm text-gray-400 dark:text-zinc-500'>
            <span className='font-semibold'>Project ID:</span>{' '}
            {setupData.project_id}
          </div>
        )}
      </div>

      <div className='space-y-4 mb-6'>
        <div className='flex items-center p-3 bg-gray-50 dark:bg-zinc-800 rounded-lg'>
          <StepIndicator
            key='step-1'
            stepNumber={1}
            isCompleted={step1Completed}
            isAnimating={step1Animating}
          />
          <span className='flex-1 text-gray-700 dark:text-zinc-300'>
            Copy the setup SQL
          </span>
          <button
            onClick={copyToClipboard}
            className={`w-[7rem] relative inline-flex items-center justify-center transition-all duration-300 ease-in-out text-xs px-3 py-1.5 rounded ${
              copied
                ? 'bg-green-50 border-green-300 text-green-600 dark:bg-green-900/20 dark:border-green-800 dark:text-green-400 border'
                : 'bg-white dark:bg-transparent border text-gray-800 dark:text-white border-purple-500 hover:bg-purple-500/10'
            } cursor-pointer`}>
            {copied ? (
              <CheckCircle className='w-4 h-4 absolute left-3' />
            ) : (
              <Copy className='w-4 h-4 absolute left-3' />
            )}
            <span className='text-center w-full pl-4 transition-opacity duration-300 ease-in-out'>
              {copied ? 'Copied!' : 'Copy SQL'}
            </span>
          </button>
        </div>

        <div className='flex items-center p-3 bg-gray-50 dark:bg-zinc-800 rounded-lg'>
          <StepIndicator
            key='step-2'
            stepNumber={2}
            isCompleted={step2Completed}
            isAnimating={step2Animating}
          />
          <span className='flex-1 text-gray-700 dark:text-zinc-300'>
            {setupData?.sql_editor_url 
              ? 'Paste and Run the SQL in Supabase SQL Editor'
              : 'Open your local Supabase Studio and run the SQL in the SQL Editor tab'
            }
          </span>
          {setupData?.sql_editor_url && (
            <Button
              variant='outline'
              size='sm'
              icon={<ExternalLink className='w-4 h-4' />}
              onClick={openSqlEditor}>
              Open Editor
            </Button>
          )}
        </div>

        {(autoVerifying || pollingTimeoutReached) && (
          <div className='flex items-center p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg'>
            <div className='w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 text-white rounded-full flex items-center justify-center mr-3 shadow-sm shadow-blue-500/30'>
              {autoVerifying ? (
                <Loader2 className='w-4 h-4 animate-spin' />
              ) : (
                <span className='text-sm font-bold'>3</span>
              )}
            </div>
            <span className='flex-1 text-blue-700 dark:text-blue-300'>
              {autoVerifying
                ? 'Waiting for you to run the SQL...'
                : 'Run the SQL then re-check'}
            </span>
            {pollingTimeoutReached && (
              <button
                onClick={manualCheck}
                disabled={checkingManually}
                className={`ml-3 w-[7.5rem] relative inline-flex items-center justify-center transition-all duration-300 ease-in-out text-xs px-3 py-1.5 rounded ${
                  buttonState === 'failed'
                    ? 'bg-red-50 border-red-300 text-red-600 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400 border'
                    : 'bg-white dark:bg-transparent border text-gray-800 dark:text-white border-purple-500 hover:bg-purple-500/10'
                } ${
                  checkingManually ? 'cursor-not-allowed' : 'cursor-pointer'
                }`}>
                <RefreshCw
                  className={`w-4 h-4 absolute left-3 ${
                    checkingManually
                      ? 'animate-[spin-twice_0.8s_ease-in-out_1_forwards]'
                      : ''
                  }`}
                />
                <span
                  className='text-center w-full pl-4 transition-opacity duration-300 ease-in-out'
                  key={buttonState}>
                  {buttonState === 'failed' ? 'Not Ready' : 'Check Now'}
                </span>
              </button>
            )}
          </div>
        )}
      </div>

      <div className='flex justify-end'>
        <div className='relative group'>
          <Button
            variant='primary'
            onClick={verifySetup}
            disabled={autoVerifying || pollingTimeoutReached}
            className={
              autoVerifying || pollingTimeoutReached
                ? 'cursor-not-allowed opacity-50'
                : ''
            }>
            Next
          </Button>
          {(autoVerifying || pollingTimeoutReached) && (
            <div className='absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-gray-800 dark:bg-gray-900 text-white text-sm rounded-lg shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10'>
              {autoVerifying
                ? 'Please run the SQL in Supabase first'
                : 'Use "Check Now" button to verify setup'}
              <div className='absolute top-full left-1/2 transform -translate-x-1/2 -translate-y-1/2 rotate-45 w-2 h-2 bg-gray-800 dark:bg-gray-900'></div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
};

/**
 * Memoized DatabaseSetupStep component
 * @component
 */
export const DatabaseSetupStep = memo(DatabaseSetupStepComponent);
DatabaseSetupStep.displayName = 'DatabaseSetupStep';
