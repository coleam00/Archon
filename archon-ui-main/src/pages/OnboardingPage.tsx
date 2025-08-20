import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { databaseService } from '../services/databaseService';
import { motion } from 'framer-motion';
import { Sparkles, Key, Check, ArrowRight } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ProviderStep } from '../components/onboarding/ProviderStep';
import { DatabaseSetupStep } from '../components/onboarding/DatabaseSetupStep';

export const OnboardingPage = () => {
  const [currentStep, setCurrentStep] = useState(1);
  const [databaseSetupNeeded, setDatabaseSetupNeeded] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    const checkDatabaseStatus = async () => {
      try {
        const status = await databaseService.getStatus();
        setDatabaseSetupNeeded(status.setup_required);
      } catch (error) {
        console.error('Failed to check database status:', error);
        setDatabaseSetupNeeded(true);
      }
    };

    checkDatabaseStatus();
  }, []);

  const handleDatabaseSetupComplete = () => {
    setCurrentStep(3);
  };


  const handleProviderSaved = () => {
    setCurrentStep(4);
  };

  const handleProviderSkip = () => {
    // Navigate to settings with guidance
    navigate('/settings');
  };

  const handleComplete = useCallback(() => {
    // Mark onboarding as dismissed and navigate to home
    localStorage.setItem('onboardingDismissed', 'true');
    navigate('/');
  }, [navigate]);

  const containerVariants = useMemo(() => ({
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1
      }
    }
  }), []);

  const itemVariants = useMemo(() => ({
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.5 }
    }
  }), []);

  const progressSteps = useMemo(() => 
    databaseSetupNeeded ? [1, 2, 3, 4] : [1, 3, 4]
  , [databaseSetupNeeded]);

  const handleGetStarted = useCallback(() => {
    setCurrentStep(databaseSetupNeeded ? 2 : 3);
  }, [databaseSetupNeeded]);

  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <motion.div
        initial="hidden"
        animate="visible"
        variants={containerVariants}
        className="w-full max-w-2xl"
      >
        {/* Progress Indicators */}
        <motion.div variants={itemVariants} className="flex justify-center mb-8 gap-3">
          {progressSteps.map((step) => (
            <div
              key={step}
              className={`h-2 w-16 rounded-full transition-colors duration-300 ${
                step <= currentStep
                  ? 'bg-blue-500'
                  : 'bg-gray-200 dark:bg-zinc-800'
              }`}
            />
          ))}
        </motion.div>

        {/* Step 1: Welcome */}
        {currentStep === 1 && (
          <motion.div variants={itemVariants}>
            <Card className="p-12 text-center">
              <div className="flex justify-center mb-6">
                <div className="w-20 h-20 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                  <Sparkles className="w-10 h-10 text-white" />
                </div>
              </div>
              
              <h1 className="text-3xl font-bold text-gray-800 dark:text-white mb-4">
                Welcome to Archon
              </h1>
              
              <p className="text-lg text-gray-600 dark:text-zinc-400 mb-8 max-w-md mx-auto">
                Let's get you set up with Supabase and your AI provider for intelligent knowledge retrieval and code assistance.
              </p>
              
              <Button
                variant="primary"
                size="lg"
                icon={<ArrowRight className="w-5 h-5 ml-2" />}
                iconPosition="right"
                onClick={handleGetStarted}
                className="min-w-[200px]"
              >
                Get Started
              </Button>
            </Card>
          </motion.div>
        )}

        {/* Step 2: Database Setup */}
        {currentStep === 2 && databaseSetupNeeded && (
          <motion.div variants={itemVariants}>
            <DatabaseSetupStep
              onComplete={handleDatabaseSetupComplete}
            />
          </motion.div>
        )}

        {/* Step 3: Provider Setup */}
        {currentStep === 3 && (
          <motion.div variants={itemVariants}>
            <Card className="p-12">
              <div className="flex items-center mb-6">
                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-green-500 to-teal-600 flex items-center justify-center mr-4">
                  <Key className="w-6 h-6 text-white" />
                </div>
                <h2 className="text-2xl font-bold text-gray-800 dark:text-white">
                  Configure AI Provider
                </h2>
              </div>
              
              <ProviderStep
                onSaved={handleProviderSaved}
                onSkip={handleProviderSkip}
              />
            </Card>
          </motion.div>
        )}

        {/* Step 4: All Set */}
        {currentStep === 4 && (
          <motion.div variants={itemVariants}>
            <Card className="p-12 text-center">
              <div className="flex justify-center mb-6">
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{
                    type: "spring",
                    stiffness: 260,
                    damping: 20
                  }}
                  className="w-20 h-20 rounded-full bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center"
                >
                  <Check className="w-10 h-10 text-white" />
                </motion.div>
              </div>
              
              <h1 className="text-3xl font-bold text-gray-800 dark:text-white mb-4">
                All Set!
              </h1>
              
              <p className="text-lg text-gray-600 dark:text-zinc-400 mb-8 max-w-md mx-auto">
                You're ready to start using Archon. Begin by adding knowledge sources through website crawling or document uploads.
              </p>
              
              <Button
                variant="primary"
                size="lg"
                onClick={handleComplete}
                className="min-w-[200px]"
              >
                Start Using Archon
              </Button>
            </Card>
          </motion.div>
        )}
      </motion.div>
    </div>
  );
};