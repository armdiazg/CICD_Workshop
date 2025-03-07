import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { aws_codeconnections as codeconnections } from 'aws-cdk-lib';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';

interface ConsumerProps extends StackProps {
    ecrRepository: ecr.Repository;
    fargateServiceTest: ecsPatterns.ApplicationLoadBalancedFargateService,
    fargateServiceProd: ecsPatterns.ApplicationLoadBalancedFargateService,
  }

export class PipelineCdkStack extends Stack {
    constructor(scope: Construct, id: string, props: ConsumerProps) {
    super(scope, id, props);

    const SourceConnection = new codeconnections.CfnConnection(this, 'CICD_Workshop_Connection', {
        connectionName: 'CICD_Workshop_Connection',
        providerType: 'GitHub',
    });

    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'Pipeline',
      crossAccountKeys: false,
      pipelineType: codepipeline.PipelineType.V2,
      executionMode: codepipeline.ExecutionMode.QUEUED,
    });

    const codeBuild = new codebuild.PipelineProject( this, 'CodeBuild', {
        environment: {
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
          privileged: true,
          computeType: codebuild.ComputeType.LARGE,
        },
        buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec_test.yml'),
      }
    );

    const dockerBuild = new codebuild.PipelineProject(this, 'DockerBuild', {
        environmentVariables: {
          IMAGE_TAG: { value: 'latest' },
          IMAGE_REPO_URI: { value: props.ecrRepository.repositoryUri },
          AWS_DEFAULT_REGION: { value: process.env.CDK_DEFAULT_REGION },
        },
        environment: {
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
          privileged: true,
          computeType: codebuild.ComputeType.LARGE,
        },
        buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec_docker.yml'),
      });
  
      const dockerBuildRolePolicy = new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: ['*'],
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:GetRepositoryPolicy',
          'ecr:DescribeRepositories',
          'ecr:ListImages',
          'ecr:DescribeImages',
          'ecr:BatchGetImage',
          'ecr:InitiateLayerUpload',
          'ecr:UploadLayerPart',
          'ecr:CompleteLayerUpload',
          'ecr:PutImage',
        ],
      });
  
      dockerBuild.addToRolePolicy(dockerBuildRolePolicy);  

    const sourceOutput = new codepipeline.Artifact();
    const unitTestOutput = new codepipeline.Artifact();
    const dockerBuildOutput = new codepipeline.Artifact();

    pipeline.addStage({
      stageName: 'Source',
      actions: [
        new codepipeline_actions.CodeStarConnectionsSourceAction({
          actionName: 'GitHub',
          owner: 'armdiazg',
          repo: 'CICD_Workshop',
          output: sourceOutput,
          branch: 'main',
          connectionArn: 'arn:aws:codeconnections:us-west-2:880512141351:connection/516f78c9-8fac-41c5-b9ac-7ad22a62f6c5',
        }),
      ],
    });

    pipeline.addStage({
      stageName: 'Code-Quality-Testing',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Unit-Test',
          project: codeBuild,
          input: sourceOutput,
          outputs: [unitTestOutput],
        }),
      ],
    });

    pipeline.addStage({
        stageName: 'Docker-Push-ECR',
        actions: [
          new codepipeline_actions.CodeBuildAction({
            actionName: 'Docker-Build',
            project: dockerBuild,
            input: sourceOutput,
            outputs: [dockerBuildOutput],
          }),
        ],
      });
    
      pipeline.addStage({
        stageName: 'Deploy-Test',
        actions: [
          new codepipeline_actions.EcsDeployAction({
            actionName: 'Deploy-Fargate-Test',
            service: props.fargateServiceTest.service,
            input: dockerBuildOutput,
          }),
        ],
      });
  
      pipeline.addStage({
        stageName: 'Deploy-Production',
        actions: [
          new codepipeline_actions.ManualApprovalAction({
            actionName: 'Approve-Deploy-Prod',
            runOrder: 1,
          }),
          new codepipeline_actions.EcsDeployAction({
            actionName: 'Deploy-Fargate-Prod',
            service: props.fargateServiceProd.service,
            input: dockerBuildOutput,
            runOrder: 2,
          }),
        ],
      });  

    new CfnOutput(this, 'SourceConnectionArn', {
        value: SourceConnection.attrConnectionArn,
    });

    new CfnOutput(this, 'SourceConnectionStatus', {
        value: SourceConnection.attrConnectionStatus,
    });
  }
}