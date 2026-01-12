import {
  App,
  CfnOutput,
  CustomResource,
  Duration,
  RemovalPolicy,
  Stack,
} from "aws-cdk-lib";
import { SecurityGroup, Vpc } from "aws-cdk-lib/aws-ec2";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import {
  Code,
  Function,
  IFunction,
  LoggingFormat,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { ILogGroup, LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Provider } from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

const env = {
  region: process.env.CDK_DEFAULT_REGION,
  account: process.env.CDK_DEFAULT_ACCOUNT,
};

class KBuildStack extends Stack {
  constructor(scope: Construct) {
    super(scope, "KBuild", { env });

    const image = new KBuildImage(this, "Image");

    new CfnOutput(this, "ImageId", { value: image.imageId });
    new CfnOutput(this, "VolumeId", { value: image.volumeId });
  }
}

class KBuildImage extends Construct {
  readonly imageId: string;
  readonly volumeId: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const logGroup = new LogGroup(this, "LogGroup", {
      removalPolicy: RemovalPolicy.DESTROY,
      retention: RetentionDays.ONE_MONTH,
    });
    const vpc = Vpc.fromLookup(this, "VPC", { isDefault: true });
    const secGroup = new SecurityGroup(this, "SecurityGroup", {
      vpc,
      allowAllIpv6Outbound: true,
      allowAllOutbound: true,
    });

    const provider = new Provider(this, "Provider", {
      onEventHandler: this.createCRHandler("on_event", logGroup, [
        new PolicyStatement({
          actions: ["ec2:RunInstances", "ec2:CreateVolume", "ec2:CreateTags"],
          resources: ["*"],
        }),
      ]),
      isCompleteHandler: this.createCRHandler("is_complete", logGroup, [
        new PolicyStatement({
          actions: ["ec2:DescribeVolumes", "ssm:DescribeInstanceInformation"],
          resources: ["*"],
        }),
      ]),
      logGroup,
    });

    const image = new CustomResource(this, "CustomResource", {
      resourceType: "Custom::KernelBuilderImage",
      serviceToken: provider.serviceToken,
      properties: {
        SecurityGroupId: secGroup.securityGroupId,
        SourceImageId: StringParameter.valueFromLookup(
          this,
          "/aws/service/ami-amazon-linux-latest/al2023-ami-minimal-kernel-default-x86_64",
        ),
      },
    });

    this.imageId = image.getAttString("ImageId");
    this.volumeId = image.getAttString("VolumeId");
  }

  private createCRHandler(
    name: string,
    logGroup: ILogGroup,
    policy: PolicyStatement[],
  ): IFunction {
    return new Function(this, `crHandler${name}`, {
      runtime: Runtime.PYTHON_3_13,
      handler: `handler.${name}`,
      code: Code.fromAsset(`${__dirname}/custom-resource`),
      timeout: Duration.minutes(15),
      initialPolicy: policy,
      logGroup,
      loggingFormat: LoggingFormat.JSON,
    });
  }
}

new KBuildStack(new App());
